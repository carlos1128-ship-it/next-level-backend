/**
 * =============================================================================
 * WHATSAPP SERVICE — Production-Ready with Neon Session Persistence
 * =============================================================================
 *
 * CORE PROBLEM SOLVED:
 * Render uses an ephemeral filesystem. Every deploy wipes the `tokens/` folder
 * that wppconnect uses to store session data by default, forcing re-scans on
 * every restart. This service replaces that filesystem store with Neon (PostgreSQL)
 * via the official `tokenStore` API, making sessions survive restarts indefinitely.
 *
 * HOW tokenStore WORKS (wppconnect official API):
 *  - wppconnect.create({ tokenStore: myStore }) replaces the default FileTokenStore
 *  - getToken(sessionName) → called at startup; if it returns a token, WA Web
 *    restores the session silently without needing a new QR scan
 *  - setToken(sessionName, tokenData) → called whenever WA rotates the token;
 *    we persist it to Neon immediately
 *  - removeToken(sessionName) → called on logout; we clear the DB column
 *
 * HANDSHAKE VALIDATION:
 *  - statusFind: fires intermediate states (notLogged, isLogged, inChat...)
 *    → used for UI feedback ONLY, never emits "Connected"
 *  - onStateChange(CONNECTED): the ONLY place we set status = "Connected"
 *    → fires after the full WA Web handshake + sync is complete
 *
 * DIAGNOSTICS:
 *  - onStreamChange: low-level connectivity logs; catches mobile phone dropouts
 *    before they escalate to a full DISCONNECTED state
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
  tokenStore,
} from '@wppconnect-team/wppconnect';
import type { SessionToken, TokenStore } from '@wppconnect-team/wppconnect/dist/token-store/types';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../prisma/prisma.service';

// ─── Supporting Types ─────────────────────────────────────────────────────────

interface SendTemplateInput {
  to: string;
  template: string;
  language?: string;
  components?: Array<Record<string, unknown>>;
}

/**
 * Global client map survives NestJS hot-module-reload cycles in dev.
 * A single globalThis Map means the same browser process is reused across
 * module re-initializations, preventing zombie Chromium instances.
 */
type GlobalWithWpp = typeof globalThis & {
  __NEXT_LEVEL_WPP_CLIENTS__?: Map<string, WppWhatsapp>;
};

// ─── Chromium Launch Config ───────────────────────────────────────────────────

/**
 * Render-optimized Chromium flags.
 * --disable-dev-shm-usage is the most critical flag: Render containers have a
 * tiny /dev/shm partition (<64MB). Without this flag, Chromium crashes with
 * "Target closed" when the shared memory fills up during WhatsApp Web load.
 */
const CHROMIUM_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',        // ← most important for Render stability
  '--disable-accelerated-2d-canvas',
  '--no-first-run',
  '--no-zygote',
  '--single-process',               // lower memory footprint for RPA workloads
  '--disable-gpu',
  '--disable-extensions',
  '--disable-default-apps',
  '--no-default-browser-check',
];

/**
 * Pinned Chrome UA prevents WhatsApp Web from flagging the headless browser
 * as suspicious. Update this when Chrome major version advances significantly.
 */
const WHATSAPP_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ─── Neon Token Store ─────────────────────────────────────────────────────────

/**
 * NeonTokenStore — a custom wppconnect TokenStore backed by PostgreSQL.
 *
 * WHY a class instead of a plain object:
 * wppconnect's `isValidTokenStore()` validates the store against the interface.
 * A class implementation satisfies that check cleanly and can be unit-tested
 * in isolation from the service.
 *
 * All tokens for a company are stored as serialized JSON in the
 * `Company.whatsappSessionToken` TEXT column (already exists in schema).
 */
class NeonTokenStore implements TokenStore {
  constructor(
    private readonly prisma: PrismaService,
    private readonly companyId: string,
    private readonly logger: Logger,
  ) {}

  /** Called by wppconnect at startup to restore a previous session without QR */
  async getToken(_sessionName: string): Promise<SessionToken | undefined> {
    try {
      const company = await this.prisma.company.findUnique({
        where: { id: this.companyId },
        select: { whatsappSessionToken: true },
      });

      if (!company?.whatsappSessionToken) {
        this.logger.log(`[${this.companyId}] Nenhum token salvo — novo QR será gerado.`);
        return undefined;
      }

      const parsed = JSON.parse(company.whatsappSessionToken) as SessionToken;
      this.logger.log(`[${this.companyId}] ✅ Token restaurado do Neon — tentando reautenticar sem QR.`);
      return parsed;

    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`[${this.companyId}] Falha ao ler token do DB: ${msg}. Limpando dado corrompido.`);
      // Clear corrupted data so the cron doesn't retry a broken token forever
      await this.prisma.company.update({
        where: { id: this.companyId },
        data: { whatsappSessionToken: null },
      }).catch(() => null);
      return undefined;
    }
  }

  /** Called by wppconnect whenever the session token is rotated */
  async setToken(_sessionName: string, tokenData: SessionToken | null): Promise<boolean> {
    try {
      await this.prisma.company.update({
        where: { id: this.companyId },
        data: {
          whatsappSessionToken: tokenData ? JSON.stringify(tokenData) : null,
        },
      });
      this.logger.log(`[${this.companyId}] 💾 Token atualizado no Neon.`);
      return true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`[${this.companyId}] Falha ao salvar token: ${msg}`);
      return false;
    }
  }

  /** Called by wppconnect on explicit logout */
  async removeToken(_sessionName: string): Promise<boolean> {
    try {
      await this.prisma.company.update({
        where: { id: this.companyId },
        data: { whatsappSessionToken: null },
      });
      this.logger.log(`[${this.companyId}] 🗑️ Token removido do Neon.`);
      return true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`[${this.companyId}] Falha ao remover token: ${msg}`);
      return false;
    }
  }

  /** Required by the TokenStore interface — returns all company sessions */
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

  /**
   * Tracks in-flight bootstrapClient() promises so concurrent createSession()
   * calls for the same company share a single initialization path.
   * Prevents double-browser from two simultaneous requests.
   */
  private readonly initializations = new Map<string, Promise<WppWhatsapp>>();

  /** QR code base64 data URIs, keyed by companyId */
  private readonly qrCodes = new Map<string, string>();

  /** Human-readable connection status for the frontend status badge */
  private readonly statuses = new Map<string, string>();

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

  async createSession(
    companyId: string,
  ): Promise<{ success: boolean; message: string }> {
    // Already connected — return immediately, no double-browser
    if (this.getClients().has(companyId)) {
      return { success: true, message: 'Sessão já conectada' };
    }

    // Deduplicate concurrent calls — only one bootstrap per companyId
    if (!this.initializations.has(companyId)) {
      this.initializations.set(companyId, this.bootstrapClient(companyId));
    }

    return {
      success: true,
      message: 'Sessão iniciada — aguardando QR ou restauração automática',
    };
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
      this.logger.error(
        `Erro ao desconectar [${companyId}]: ${(error as Error).message}`,
      );
      throw new InternalServerErrorException('Falha ao desconectar sessão');
    } finally {
      // Always clean memory and DB, even if logout throws
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

  // ─── Messaging ──────────────────────────────────────────────────────────────

  async sendTextMessage(companyId: string, to: string, message: string) {
    const client = this.requireClient(companyId);
    await client.sendText(this.normalizeRecipient(to), message);
    return { sent: true };
  }

  async sendTemplateMessage(companyId: string, payload: SendTemplateInput) {
    if (!payload.template) throw new BadRequestException('template obrigatório');
    const client = this.requireClient(companyId);
    const recipient = this.normalizeRecipient(payload.to);
    const body = [
      `Template: ${payload.template}`,
      payload.language ? `Idioma: ${payload.language}` : '',
      payload.components?.length
        ? `Componentes: ${JSON.stringify(payload.components)}`
        : '',
    ]
      .filter(Boolean)
      .join('\n');
    await client.sendText(recipient, body);
    return { sent: true };
  }

  async discoverBusinessProfile() {
    throw new BadRequestException(
      'discoverBusinessProfile desativado no modo WPPConnect local.',
    );
  }

  // ─── Core Bootstrap ─────────────────────────────────────────────────────────

  /**
   * Creates the wppconnect client with full Neon-backed session persistence.
   *
   * KEY DECISIONS:
   *
   * tokenStore → NeonTokenStore instance replaces the default FileTokenStore.
   *   This is the single change that survives Render restarts.
   *
   * autoClose: 0 → disables the auto-disconnect timeout. Without this, large
   *   accounts that take >2min to sync their chat history trigger a self-destruct.
   *
   * waitForLogin: false → create() returns immediately; state is managed via
   *   events. This prevents the HTTP request that triggered createSession()
   *   from hanging until the user scans the QR.
   *
   * folderNameToken: '/tmp/.wppconnect' → even though we use NeonTokenStore,
   *   wppconnect may still write temp files. /tmp is always writable on Render.
   */
  private async bootstrapClient(companyId: string): Promise<WppWhatsapp> {
    this.logger.log(`[${companyId}] 🚀 Inicializando sessão WPPConnect com Neon tokenStore...`);

    // Instantiate our custom Neon-backed token store for this company
    const neonStore = new NeonTokenStore(this.prisma, companyId, this.logger);

    const client = await create({
      session: `company-${companyId}`,
      tokenStore: neonStore,           // ← THE key change: DB persistence
      headless: this.resolveHeadless() as any,
      logQR: false,
      updatesLog: false,
      autoClose: 0,                    // ← Never auto-close; we manage lifecycle
      waitForLogin: false,             // ← Non-blocking; events drive state
      disableWelcome: true,
      folderNameToken: '/tmp/.wppconnect',

      // ── QR Code handler ────────────────────────────────────────────────────
      // Fires when session restoration fails (expired token) or first login
      catchQR: (base64Qr: string, _ascii: string, attempt: number) => {
        this.logger.log(`[${companyId}] 📱 QR Code gerado (tentativa ${attempt})`);
        const uri = base64Qr.startsWith('data:')
          ? base64Qr
          : `data:image/png;base64,${base64Qr}`;
        this.qrCodes.set(companyId, uri);
        this.statuses.set(companyId, 'QR_READY');
        this.eventEmitter.emit('whatsapp.qr.generated', { companyId, qrCode: uri });
      },

      // ── TASK 2: statusFind — intermediate states, NEVER sets "Connected" ──
      // Logs help diagnose authentication flow; do not emit Connected here.
      // isLogged/inChat can fire before full sync — premature "Connected" events
      // would show the UI as connected while chats are still loading.
      statusFind: (statusSession: string, session: string) => {
        this.logger.log(`[${companyId}] statusFind → ${statusSession} (session: ${session})`);

        if (statusSession === 'notLogged') {
          this.statuses.set(companyId, 'Awaiting QR');
        } else if (statusSession === 'qrReadSuccess') {
          this.statuses.set(companyId, 'QR Scanned — Authenticating...');
        } else if (statusSession === 'chatsAvailable') {
          this.statuses.set(companyId, 'Syncing...');
        }
        // NOTE: isLogged / inChat intentionally NOT setting "Connected" here
      },

      onLoadingScreen: (percent: number, message: string) => {
        this.logger.log(`[${companyId}] 🔄 ${percent}% — ${message}`);
      },

      puppeteerOptions: {
        headless: this.resolveHeadless() as any,
        executablePath:
          process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/google-chrome',
        args: [`--user-agent=${WHATSAPP_USER_AGENT}`, ...CHROMIUM_ARGS],
        // No userDataDir — session data lives in Neon, not on disk
      },
    });

    // ── Race-condition guard ──────────────────────────────────────────────────
    // If terminateSession() was called while bootstrapClient() was in flight,
    // we must not register this zombie client in the global Map.
    if (
      !this.initializations.has(companyId) &&
      !this.getClients().has(companyId)
    ) {
      this.logger.warn(
        `[${companyId}] Sessão foi abortada durante o bootstrap. Encerrando instância zumbi.`,
      );
      await client.close().catch(() => null);
      return client;
    }

    // Register the live client globally
    this.getClients().set(companyId, client);
    this.initializations.delete(companyId);
    this.logger.log(`[${companyId}] ✅ Cliente WPPConnect registrado com sucesso.`);

    // Attach event listeners after client is registered
    this.attachEventListeners(client, companyId);

    return client;
  }

  // ─── TASK 2 & 3: Event Listeners ─────────────────────────────────────────────

  /**
   * Attaches post-creation event listeners. Separated from bootstrapClient()
   * for clarity and testability.
   */
  private attachEventListeners(client: WppWhatsapp, companyId: string): void {

    // ── TASK 2: onStateChange — THE authoritative "Connected" gate ────────────
    // WA Web fires CONNECTED only after full handshake + initial sync completes.
    // All other states (including statusFind's isLogged) are premature.
    client.onStateChange(async (state: string) => {
      this.logger.log(`[${companyId}] 🔁 onStateChange → ${state}`);

      switch (state) {
        case 'CONNECTED': {
          this.statuses.set(companyId, 'Connected');
          this.qrCodes.delete(companyId);

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
              this.logger.log(`[${companyId}] 📞 WID salvo: ${wid}`);
            }
          } catch (widErr: unknown) {
            const msg = widErr instanceof Error ? widErr.message : String(widErr);
            this.logger.warn(`[${companyId}] Não foi possível obter WID: ${msg}`);
          }

          this.eventEmitter.emit('whatsapp.session.connected', { companyId });
          break;
        }

        case 'CONFLICT':
        case 'UNPAIRED':
        case 'UNLAUNCHED': {
          // Another device took over or the phone unlinked this session
          this.logger.warn(
            `[${companyId}] Sessão conflitante/desvinculada (${state}).`,
          );
          this.statuses.set(companyId, 'Disconnected');
          this.eventEmitter.emit('whatsapp.session.disconnected', {
            companyId,
            reason: state,
          });
          break;
        }

        case 'DISCONNECTED': {
          this.statuses.set(companyId, 'Disconnected');
          this.logger.warn(`[${companyId}] Sessão desconectada.`);
          this.eventEmitter.emit('whatsapp.session.disconnected', {
            companyId,
            reason: 'DISCONNECTED',
          });
          break;
        }
      }
    });

    // ── TASK 3: onStreamChange — low-level connectivity diagnostics ───────────
    // Stream states expose the websocket connection between Chromium and WA servers.
    // DISCONNECTED/TIMEOUT here often means: mobile data off, phone locked, or
    // Render server is too slow to keep the WA Web socket alive.
    // This does NOT necessarily mean the session is lost — WA usually recovers.
    client.onStreamChange((streamState: string) => {
      this.logger.log(`[${companyId}] 📡 onStreamChange → ${streamState}`);

      if (streamState === 'DISCONNECTED' || streamState === 'TIMEOUT') {
        this.logger.warn(
          `[${companyId}] Stream interrompido (${streamState}). ` +
          'O celular pode estar sem dados ou o servidor está lento. WA tentará reconectar automaticamente.',
        );
      }
      // SYNCING is informational — large accounts take 30s–2min on first connect
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
    this.getClients().delete(companyId);
    this.initializations.delete(companyId);
    this.statuses.delete(companyId);
    this.qrCodes.delete(companyId);
  }

  private async clearDbSession(companyId: string): Promise<void> {
    await this.prisma.company.update({
      where: { id: companyId },
      data: {
        whatsappSessionName: null,
        whatsappWid: null,
        whatsappSessionToken: null,
      },
    }).catch((e: Error) =>
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
