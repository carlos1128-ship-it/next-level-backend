/**
 * =============================================================================
 * WHATSAPP SERVICE — Neon Persistence + Deadlock Detection + Production Render
 * =============================================================================
 *
 * PROBLEM SOLVED IN THIS VERSION:
 * The previous version could deadlock when an invalid/expired session token was
 * stored in the DB. wppconnect would try (and silently fail) to restore the
 * session, the browser would sit idle, and no QR would ever be emitted.
 *
 * SOLUTION:
 *  1. 15-second deadlock timer fires after token-restore attempt.
 *     If CONNECTED is not received in time → forceNewSession() is called,
 *     the bad token is purged, and a fresh QR is generated automatically.
 *  2. Frontend receives granular state events: SESSION_STATUS(RESTORING),
 *     QR_CODE, SESSION_STATUS(CONNECTED), SESSION_STATUS(DISCONNECTED)
 *  3. /tmp session cache is wiped before each create() call to avoid
 *     stale Chromium profile conflicts from previous Render dyno runs.
 * =============================================================================
 */

import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  OnModuleDestroy,
} from '@nestjs/common';
import {
  create,
  Whatsapp as WppWhatsapp,
} from '@wppconnect-team/wppconnect';
import type {
  SessionToken,
  TokenStore,
} from '@wppconnect-team/wppconnect/dist/token-store/types';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../prisma/prisma.service';
import * as fs from 'fs';
import * as path from 'path';

// ─── Supporting Types ─────────────────────────────────────────────────────────

interface SendTemplateInput {
  to: string;
  template: string;
  language?: string;
  components?: Array<Record<string, unknown>>;
}

type GlobalWithWpp = typeof globalThis & {
  __NEXT_LEVEL_WPP_CLIENTS__?: Map<string, WppWhatsapp>;
};

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * How long we wait for CONNECTED state after a token-restore attempt before
 * declaring deadlock and forcing a fresh QR session.
 */
const DEADLOCK_TIMEOUT_MS = 15_000;

/** /tmp is always writable on Render; avoids ephemeral-FS issues */
const SESSION_BASE_DIR = '/tmp/.wppconnect';

/**
 * Render-optimized Chromium args.
 * --disable-dev-shm-usage is the most critical: Render's /dev/shm is tiny
 * (<64 MB), causing "Target closed" crashes without this flag.
 */
const CHROMIUM_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-accelerated-2d-canvas',
  '--no-first-run',
  '--no-zygote',
  '--single-process',
  '--disable-gpu',
  '--disable-extensions',
  '--disable-default-apps',
  '--no-default-browser-check',
];

/** Pinned stable Chrome UA — prevents WA Web security flags on headless */
const WHATSAPP_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ─── NeonTokenStore ───────────────────────────────────────────────────────────

/**
 * Custom wppconnect TokenStore backed by Neon (PostgreSQL).
 * Replaces the default FileTokenStore, which is useless on Render's ephemeral FS.
 *
 * Interface: getToken / setToken / removeToken / listTokens
 * All methods are async and include safe JSON parse with corruption handling.
 */
class NeonTokenStore implements TokenStore {
  constructor(
    private readonly prisma: PrismaService,
    private readonly companyId: string,
    private readonly logger: Logger,
  ) {}

  async getToken(_sessionName: string): Promise<SessionToken | undefined> {
    try {
      const company = await this.prisma.company.findUnique({
        where: { id: this.companyId },
        select: { whatsappSessionToken: true },
      });

      if (!company?.whatsappSessionToken) {
        this.logger.log(
          `[WA-TOKEN][${this.companyId}] No session token found. Proceeding to generate QR code.`,
        );
        return undefined;
      }

      const parsed = JSON.parse(company.whatsappSessionToken) as SessionToken;
      this.logger.log(
        `[WA-TOKEN][${this.companyId}] Session token found in DB. Attempting restore...`,
      );
      return parsed;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `[WA-TOKEN][${this.companyId}] Token read/parse failed: ${msg}. Clearing corrupted data.`,
      );
      await this.prisma.company
        .update({ where: { id: this.companyId }, data: { whatsappSessionToken: null } })
        .catch(() => null);
      return undefined;
    }
  }

  async setToken(_sessionName: string, tokenData: SessionToken | null): Promise<boolean> {
    try {
      await this.prisma.company.update({
        where: { id: this.companyId },
        data: { whatsappSessionToken: tokenData ? JSON.stringify(tokenData) : null },
      });
      this.logger.log(`[WA-TOKEN][${this.companyId}] Token persisted to Neon.`);
      return true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`[WA-TOKEN][${this.companyId}] Failed to save token: ${msg}`);
      return false;
    }
  }

  async removeToken(_sessionName: string): Promise<boolean> {
    try {
      await this.prisma.company.update({
        where: { id: this.companyId },
        data: { whatsappSessionToken: null },
      });
      this.logger.log(`[WA-TOKEN][${this.companyId}] Token removed from Neon.`);
      return true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`[WA-TOKEN][${this.companyId}] Failed to remove token: ${msg}`);
      return false;
    }
  }

  async listTokens(): Promise<string[]> {
    try {
      const companies = await this.prisma.company.findMany({
        where: { whatsappSessionToken: { not: null } },
        select: { id: true },
      });
      return companies.map((c) => `company-${c.id}`);
    } catch {
      return [];
    }
  }
}

// ─── Service ──────────────────────────────────────────────────────────────────

@Injectable()
export class WhatsappService implements OnModuleDestroy {
  private readonly logger = new Logger(WhatsappService.name);

  /** Deduplicates concurrent createSession() calls for the same company */
  private readonly initializations = new Map<string, Promise<WppWhatsapp>>();

  /** QR data URIs, keyed by companyId */
  private readonly qrCodes = new Map<string, string>();

  /** Human-readable status for the frontend status badge */
  private readonly statuses = new Map<string, string>();

  /**
   * TASK 1: Stores active deadlock timers by companyId.
   * Timer is set when a DB token is found; cleared when CONNECTED fires.
   * If it ever fires → the token was invalid → forceNewSession() is called.
   */
  private readonly deadlockTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly eventEmitter: EventEmitter2,
    private readonly prisma: PrismaService,
  ) {
    if (!(globalThis as GlobalWithWpp).__NEXT_LEVEL_WPP_CLIENTS__) {
      (globalThis as GlobalWithWpp).__NEXT_LEVEL_WPP_CLIENTS__ = new Map();
    }
  }

  // ─── Public Accessors ───────────────────────────────────────────────────────

  getStatus(companyId: string): string {
    return this.statuses.get(companyId) ?? 'Disconnected';
  }

  getQrCode(companyId: string): string | null {
    return this.qrCodes.get(companyId) ?? null;
  }

  getClient(companyId: string): WppWhatsapp | undefined {
    return this.getClients().get(companyId);
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────────

  async onModuleDestroy() {
    const clients = this.getClients();
    for (const [sessionId, client] of clients.entries()) {
      try {
        await client.close();
      } catch (error) {
        this.logger.warn(
          `Falha ao encerrar cliente [${sessionId}]: ${(error as Error).message}`,
        );
      }
    }
  }

  // ─── Session Management ─────────────────────────────────────────────────────

  async createSession(companyId: string): Promise<{ success: boolean; message: string }> {
    if (this.getClients().has(companyId)) {
      return { success: true, message: 'Sessão já conectada' };
    }

    if (!this.initializations.has(companyId)) {
      this.initializations.set(companyId, this.bootstrapClient(companyId));
    }

    return { success: true, message: 'Sessão iniciada — aguardando QR ou restauração' };
  }

  async logoutSession(companyId: string) {
    const client = this.getClient(companyId);

    if (!client) {
      await this.clearDbSession(companyId);
      return { success: true, message: 'Sessão resetada no banco' };
    }

    try {
      await client.logout();
      await client.close();
    } catch (error) {
      this.logger.error(`Erro ao desconectar [${companyId}]: ${(error as Error).message}`);
      throw new InternalServerErrorException('Falha ao desconectar sessão');
    } finally {
      this.cleanupMemory(companyId);
      await this.clearDbSession(companyId);
    }

    return { success: true, message: 'Desconectado com sucesso' };
  }

  async terminateSession(companyId: string) {
    const client = this.getClient(companyId);
    if (client) {
      await client.close().catch((e: Error) =>
        this.logger.error(`Erro ao fechar cliente [${companyId}]: ${e.message}`),
      );
    }
    this.cleanupMemory(companyId);
    this.logger.log(`[WhatsappService] Sessão [${companyId}] encerrada pelo usuário.`);
    return { success: true };
  }

  // ─── TASK 1: Deadlock Recovery ────────────────────────────────────────────

  /**
   * Starts a deadlock detection timer.
   * If CONNECTED is not received within DEADLOCK_TIMEOUT_MS, the token is
   * considered stale and forceNewSession() is triggered automatically.
   *
   * Only started when a DB token actually exists (restore attempt).
   * If no token exists, we skip this — a QR will be generated normally.
   */
  private startDeadlockTimer(companyId: string): void {
    // Clear any existing timer first (safety for re-entrancy)
    this.clearDeadlockTimer(companyId);

    const timer = setTimeout(async () => {
      this.logger.error(
        `[WA-DEADLOCK][${companyId}] Session token is invalid. ` +
        `No CONNECTED state received in ${DEADLOCK_TIMEOUT_MS / 1000}s. ` +
        `Forcing re-authentication.`,
      );
      await this.forceNewSession(companyId);
    }, DEADLOCK_TIMEOUT_MS);

    this.deadlockTimers.set(companyId, timer);
  }

  /** Clears the deadlock timer — called when CONNECTED fires successfully */
  private clearDeadlockTimer(companyId: string): void {
    const existing = this.deadlockTimers.get(companyId);
    if (existing) {
      clearTimeout(existing);
      this.deadlockTimers.delete(companyId);
    }
  }

  /**
   * forceNewSession — purges the invalid DB token and restarts from scratch.
   *
   * Flow:
   *  1. Delete token from Neon so getToken() returns undefined next time
   *  2. Close + deregister the stale browser instance
   *  3. Re-call bootstrapClient() → wppconnect finds no token → emits QR
   */
  async forceNewSession(companyId: string): Promise<void> {
    this.logger.warn(`[WA-FORCE][${companyId}] Invalidating token and restarting session.`);

    // Step 1: Delete token from DB
    await this.prisma.company
      .update({
        where: { id: companyId },
        data: { whatsappSessionToken: null },
      })
      .catch((e: Error) =>
        this.logger.error(`[WA-FORCE][${companyId}] DB token clear failed: ${e.message}`),
      );

    // Step 2: Close stale browser instance
    const staleClient = this.getClient(companyId);
    if (staleClient) {
      await staleClient.close().catch(() => null);
    }
    this.cleanupMemory(companyId);

    // Step 3: Emit status so frontend shows "Reconectando..." instead of raw spinner
    this.eventEmitter.emit('whatsapp.session.status', {
      companyId,
      status: 'RECONNECTING',
      message: 'Token inválido. Gerando novo QR Code...',
    });

    // Step 4: Re-bootstrap — this time getToken() returns undefined → QR generated
    this.logger.log(`[WA-FORCE][${companyId}] Restarting bootstrap with clean state.`);
    this.initializations.set(companyId, this.bootstrapClient(companyId));
  }

  // ─── Messaging ──────────────────────────────────────────────────────────────

  async sendTextMessage(companyId: string, to: string, message: string) {
    const client = this.requireClient(companyId);
    await client.sendText(this.normalizeRecipient(to), message);
    return { sent: true };
  }

  async sendTemplateMessage(companyId: string, payload: SendTemplateInput) {
    if (!payload.template) throw new BadRequestException('template obrigatório');
    const client = this.requireClient(companyId);
    const body = [
      `Template: ${payload.template}`,
      payload.language ? `Idioma: ${payload.language}` : '',
      payload.components?.length ? `Componentes: ${JSON.stringify(payload.components)}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    await client.sendText(this.normalizeRecipient(payload.to), body);
    return { sent: true };
  }

  async discoverBusinessProfile() {
    throw new BadRequestException('discoverBusinessProfile desativado no modo WPPConnect local.');
  }

  // ─── Core Bootstrap ──────────────────────────────────────────────────────────

  private async bootstrapClient(companyId: string): Promise<WppWhatsapp> {
    this.logger.log(`[WA-START][${companyId}] Initializing connection for Company ${companyId}...`);

    // TASK 3: Wipe stale Chromium session cache from /tmp before starting
    // Prevents conflicting profile locks from previous Render dyno runs
    this.wipeTmpSessionCache(companyId);

    const neonStore = new NeonTokenStore(this.prisma, companyId, this.logger);

    // Peek at the DB to decide whether to start the deadlock timer and
    // emit the RESTORING status BEFORE calling create()
    const existingToken = await neonStore.getToken(`company-${companyId}`);
    if (existingToken) {
      // TASK 2: Notify frontend immediately so it can show "Restaurando sessão..."
      this.eventEmitter.emit('whatsapp.session.status', {
        companyId,
        status: 'RESTORING',
        message: 'Restaurando sessão, por favor aguarde...',
      });
      this.statuses.set(companyId, 'Restoring');

      // TASK 1: Start deadlock timer — cleared only when CONNECTED fires
      this.startDeadlockTimer(companyId);
    }

    const client = await create({
      session: `company-${companyId}`,
      tokenStore: neonStore,          // ← Neon replaces default FileTokenStore
      headless: true,                 // MUST be true in production
      logQR: false,
      updatesLog: false,
      autoClose: 0,                   // Never auto-close; we manage lifecycle
      waitForLogin: false,            // Non-blocking; events drive state
      disableWelcome: true,
      folderNameToken: SESSION_BASE_DIR,

      // ── TASK 2: QR code handler with enhanced logging ────────────────────
      catchQR: (base64Qr: string, _ascii: string, attempt: number) => {
        // If we get a QR while a deadlock timer is running, clear it —
        // it means the token failed silently and wppconnect fell back to QR
        this.clearDeadlockTimer(companyId);

        this.logger.log(`[WA-QR-EMIT][${companyId}] New QR Code generated and emitted to frontend. (attempt ${attempt})`);
        const uri = base64Qr.startsWith('data:')
          ? base64Qr
          : `data:image/png;base64,${base64Qr}`;
        this.qrCodes.set(companyId, uri);
        this.statuses.set(companyId, 'QR_READY');

        this.eventEmitter.emit('whatsapp.qr.generated', { companyId, qrCode: uri });
        // Also emit SESSION_STATUS so frontend can switch from "Restoring" to QR view
        this.eventEmitter.emit('whatsapp.session.status', {
          companyId,
          status: 'QR_READY',
        });
      },

      // ── TASK 2: statusFind — intermediate states ONLY, no "Connected" here ──
      statusFind: (statusSession: string, session: string) => {
        this.logger.log(
          `[WA-STATUS][${companyId}] statusFind → ${statusSession} (session: ${session})`,
        );
        if (statusSession === 'notLogged') {
          this.statuses.set(companyId, 'Awaiting QR');
        } else if (statusSession === 'qrReadSuccess') {
          this.statuses.set(companyId, 'QR Scanned — Authenticating...');
          this.eventEmitter.emit('whatsapp.session.status', {
            companyId,
            status: 'AUTHENTICATING',
          });
        } else if (statusSession === 'chatsAvailable') {
          this.statuses.set(companyId, 'Syncing...');
        }
        // isLogged / inChat intentionally NOT triggering "Connected"
      },

      onLoadingScreen: (percent: number, message: string) => {
        this.logger.log(`[WA-LOAD][${companyId}] ${percent}% — ${message}`);
      },

      // TASK 3: Production Puppeteer config
      puppeteerOptions: {
        headless: true,
        executablePath:
          process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/google-chrome',
        args: [`--user-agent=${WHATSAPP_USER_AGENT}`, ...CHROMIUM_ARGS],
        // No userDataDir → session lives in Neon, not on disk
      },
    });

    // ── Race-condition guard ────────────────────────────────────────────────
    if (!this.initializations.has(companyId) && !this.getClients().has(companyId)) {
      this.logger.warn(`[WA-START][${companyId}] Session aborted during bootstrap. Closing zombie.`);
      this.clearDeadlockTimer(companyId);
      await client.close().catch(() => null);
      return client;
    }

    this.getClients().set(companyId, client);
    this.initializations.delete(companyId);
    this.logger.log(`[WA-START][${companyId}] Client registered successfully.`);

    this.attachEventListeners(client, companyId);
    return client;
  }

  // ─── Event Listeners ─────────────────────────────────────────────────────────

  private attachEventListeners(client: WppWhatsapp, companyId: string): void {

    // ── TASK 1 + 2: onStateChange — the ONLY authoritative "Connected" gate ───
    client.onStateChange(async (state: string) => {
      this.logger.log(`[WA-STATE][${companyId}] onStateChange → ${state}`);

      if (state === 'CONNECTED') {
        // TASK 1: Healthy session confirmed → kill the deadlock timer
        this.clearDeadlockTimer(companyId);

        this.statuses.set(companyId, 'Connected');
        this.qrCodes.delete(companyId);
        this.logger.log(`[WA-CONNECTED][${companyId}] Handshake successful. Session is fully connected.`);

        // Persist WID (phone number identifier) for the UI
        try {
          const hostDevice = await client.getHostDevice();
          const wid =
            typeof hostDevice.wid === 'string'
              ? hostDevice.wid
              : (hostDevice.wid as any)?._serialized ??
                (hostDevice.id as any)?._serialized;

          if (wid) {
            await this.prisma.company.update({
              where: { id: companyId },
              data: {
                whatsappSessionName: `company-${companyId}`,
                whatsappWid: String(wid),
              },
            });
            this.logger.log(`[WA-CONNECTED][${companyId}] WID persisted: ${wid}`);
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          this.logger.warn(`[WA-CONNECTED][${companyId}] Could not retrieve WID: ${msg}`);
        }

        // TASK 2: Emit to frontend
        this.eventEmitter.emit('whatsapp.session.connected', { companyId });
        this.eventEmitter.emit('whatsapp.session.status', {
          companyId,
          status: 'CONNECTED',
        });

      } else if (['CONFLICT', 'UNPAIRED', 'UNLAUNCHED'].includes(state)) {
        this.clearDeadlockTimer(companyId);
        this.logger.warn(`[WA-STATE][${companyId}] Session conflict/unpaired (${state}).`);
        this.statuses.set(companyId, 'Disconnected');
        this.eventEmitter.emit('whatsapp.session.disconnected', { companyId, reason: state });
        this.eventEmitter.emit('whatsapp.session.status', { companyId, status: 'DISCONNECTED' });

      } else if (state === 'DISCONNECTED') {
        this.clearDeadlockTimer(companyId);
        this.statuses.set(companyId, 'Disconnected');
        this.logger.warn(`[WA-STATE][${companyId}] Session disconnected.`);
        this.eventEmitter.emit('whatsapp.session.disconnected', { companyId, reason: 'DISCONNECTED' });
        this.eventEmitter.emit('whatsapp.session.status', { companyId, status: 'DISCONNECTED' });
      }
    });

    // ── TASK 3: onStreamChange — low-level diagnostics ────────────────────────
    // Detects mobile phone dropouts before they escalate to full DISCONNECTED.
    client.onStreamChange((streamState: string) => {
      this.logger.log(`[WA-STREAM][${companyId}] onStreamChange → ${streamState}`);
      if (streamState === 'DISCONNECTED' || streamState === 'TIMEOUT') {
        this.logger.warn(
          `[WA-STREAM][${companyId}] Stream interrupted (${streamState}). ` +
          'Mobile may have lost data. WA Web will attempt auto-recovery.',
        );
      }
    });

    // ── Message listener ──────────────────────────────────────────────────────
    client.onMessage(async (message) => {
      if (message.isGroupMsg) return;
      this.eventEmitter.emit('whatsapp.message.received', {
        companyId,
        from: message.from,
        text: message.body ?? '',
        name: message.sender?.pushname ?? message.sender?.name,
      });
    });
  }

  // ─── TASK 3: /tmp Cache Cleanup ──────────────────────────────────────────────

  /**
   * Removes stale Chromium session folders from /tmp before each create() call.
   *
   * WHY: Render redeploys preserve /tmp across warm restarts within the same dyno
   * run but not across deployments. Stale lock files in these folders can prevent
   * Chromium from starting, displaying as "Target closed" or "ENOENT" errors.
   */
  private wipeTmpSessionCache(companyId: string): void {
    const sessionDir = path.join(SESSION_BASE_DIR, `company-${companyId}`);
    try {
      if (fs.existsSync(sessionDir)) {
        fs.rmSync(sessionDir, { recursive: true, force: true });
        this.logger.log(`[WA-CACHE][${companyId}] Stale /tmp session cache wiped: ${sessionDir}`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // Non-fatal: log and continue. A stale folder is annoying, not fatal.
      this.logger.warn(`[WA-CACHE][${companyId}] Could not wipe cache: ${msg}`);
    }
  }

  // ─── Private Utilities ────────────────────────────────────────────────────────

  private getClients(): Map<string, WppWhatsapp> {
    return (globalThis as GlobalWithWpp).__NEXT_LEVEL_WPP_CLIENTS__!;
  }

  private requireClient(companyId: string): WppWhatsapp {
    const client = this.getClient(companyId);
    if (!client) {
      throw new BadRequestException('WhatsApp não conectado para esta empresa.');
    }
    return client;
  }

  private cleanupMemory(companyId: string): void {
    this.clearDeadlockTimer(companyId);
    this.getClients().delete(companyId);
    this.initializations.delete(companyId);
    this.statuses.delete(companyId);
    this.qrCodes.delete(companyId);
  }

  private async clearDbSession(companyId: string): Promise<void> {
    await this.prisma.company
      .update({
        where: { id: companyId },
        data: {
          whatsappSessionName: null,
          whatsappWid: null,
          whatsappSessionToken: null,
        },
      })
      .catch((e: Error) =>
        this.logger.error(`Erro ao limpar sessão no DB [${companyId}]: ${e.message}`),
      );
  }

  private normalizeRecipient(value: string): string {
    const trimmed = value.trim();
    if (!trimmed) throw new BadRequestException('Número de destino obrigatório.');
    if (trimmed.includes('@')) return trimmed;
    const digits = trimmed.replace(/\D/g, '');
    if (!digits) throw new BadRequestException('Número de destino inválido.');
    return `${digits}@c.us`;
  }

  private resolveHeadless(): boolean | 'shell' {
    const raw = (process.env.WPPCONNECT_HEADLESS ?? 'true').trim().toLowerCase();
    if (raw === 'shell') return 'shell';
    return raw !== 'false';
  }
}
