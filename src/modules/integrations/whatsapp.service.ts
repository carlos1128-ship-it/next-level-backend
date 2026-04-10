/**
 * =============================================================================
 * WHATSAPP SERVICE — Neon Persistence + AI Response + Bulk Sending
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
import { ChatService } from '../ai/chat.service';
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

const DEADLOCK_TIMEOUT_MS = 15_000;
const SESSION_BASE_DIR = '/tmp/.wppconnect';

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

const WHATSAPP_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ─── NeonTokenStore ───────────────────────────────────────────────────────────

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
        this.logger.log(`[WA-TOKEN][${this.companyId}] No session token found.`);
        return undefined;
      }

      const parsed = JSON.parse(company.whatsappSessionToken) as SessionToken;
      this.logger.log(`[WA-TOKEN][${this.companyId}] Session token found in DB. Attempting restore...`);
      return parsed;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`[WA-TOKEN][${this.companyId}] Token parse failed: ${msg}.`);
      await this.prisma.company.update({
        where: { id: this.companyId },
        data: { whatsappSessionToken: null }
      }).catch(() => null);
      return undefined;
    }
  }

  async setToken(_sessionName: string, tokenData: SessionToken | null): Promise<boolean> {
    try {
      await this.prisma.company.update({
        where: { id: this.companyId },
        data: { whatsappSessionToken: tokenData ? JSON.stringify(tokenData) : null },
      });
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
  private readonly initializations = new Map<string, Promise<WppWhatsapp>>();
  private readonly qrCodes = new Map<string, string>();
  private readonly statuses = new Map<string, string>();
  private readonly deadlockTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly eventEmitter: EventEmitter2,
    private readonly prisma: PrismaService,
    private readonly chatService: ChatService,
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

  async getProfile(companyId: string) {
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { whatsappName: true, whatsappWid: true, whatsappAvatar: true, whatsappStatus: true },
    });
    return {
      name: company?.whatsappName || 'Unknown',
      number: company?.whatsappWid || 'Unknown',
      avatar: company?.whatsappAvatar || null,
      status: company?.whatsappStatus || this.getStatus(companyId),
    };
  }

  // ─── TASK 3: Smart Real-Time Status Check ───────────────────────────────────

  async checkLiveStatus(companyId: string): Promise<boolean> {
    const client = this.getClient(companyId);
    if (!client) return false;

    try {
      const isConnected = await client.isConnected();
      if (isConnected) {
        // Reconcile if DB or Local State is out of sync
        const companyData = await this.prisma.company.findUnique({
          where: { id: companyId },
          select: { whatsappStatus: true }
        });

        if (companyData?.whatsappStatus !== 'CONNECTED') {
          this.logger.log(`[WA-RECONCILE][${companyId}] Found live session but DB status is '${companyData?.whatsappStatus}'. Forcing sync...`);
          await this.handleConnectionStateChange('CONNECTED', client, companyId);
        }
        return true;
      }
    } catch (err) {
      this.logger.warn(`[WA-STATUS-CHECK][${companyId}] Failed to verify live status: ${err instanceof Error ? err.message : err}`);
    }
    return false;
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────────

  async onModuleDestroy() {
    const clients = this.getClients();
    for (const [sessionId, client] of clients.entries()) {
      try {
        await client.close();
      } catch (error) {
        this.logger.warn(`Falha ao encerrar cliente [${sessionId}]: ${(error as Error).message}`);
      }
    }
  }

  // ─── Session Management ─────────────────────────────────────────────────────

  async createSession(companyId: string): Promise<{ success: boolean; message: string }> {
    if (this.getClients().has(companyId)) {
      // Immediate reconciliation check
      const isLive = await this.checkLiveStatus(companyId);
      if (isLive) return { success: true, message: 'Sessão já conectada e sincronizada' };
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
    return { success: true };
  }

  async sendBulkMessages(companyId: string, numbers: string[], message: string) {
    const client = this.requireClient(companyId);
    this.logger.log(`[WA-BULK][${companyId}] Starting bulk send to ${numbers.length} numbers.`);

    for (const number of numbers) {
      try {
        const recipient = this.normalizeRecipient(number);
        await client.sendText(recipient, message);
        this.logger.log(`[WA-BULK][${companyId}] Message sent to ${number}`);

        const delay = Math.floor(Math.random() * (40000 - 20000 + 1)) + 20000;
        await new Promise((resolve) => setTimeout(resolve, delay));
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        this.logger.error(`[WA-BULK][${companyId}] Failed to send to ${number}: ${msg}`);
      }
    }
    
    this.logger.log(`[WA-BULK][${companyId}] Bulk send completed.`);
    return { success: true, total: numbers.length };
  }

  // ─── Deadlock Recovery ──────────────────────────────────────────────────────

  private startDeadlockTimer(companyId: string): void {
    this.clearDeadlockTimer(companyId);
    const timer = setTimeout(async () => {
      this.logger.error(`[WA-DEADLOCK][${companyId}] No CONNECTED state received. Forcing re-authentication.`);
      await this.forceNewSession(companyId);
    }, DEADLOCK_TIMEOUT_MS);
    this.deadlockTimers.set(companyId, timer);
  }

  private clearDeadlockTimer(companyId: string): void {
    const existing = this.deadlockTimers.get(companyId);
    if (existing) {
      clearTimeout(existing);
      this.deadlockTimers.delete(companyId);
    }
  }

  async forceNewSession(companyId: string): Promise<void> {
    await this.prisma.company.update({
      where: { id: companyId },
      data: { whatsappSessionToken: null, whatsappStatus: 'DISCONNECTED' },
    }).catch(() => null);

    const staleClient = this.getClient(companyId);
    if (staleClient) await staleClient.close().catch(() => null);
    this.cleanupMemory(companyId);

    this.eventEmitter.emit('whatsapp.session.status', {
      companyId,
      status: 'RECONNECTING',
      message: 'Token inválido. Gerando novo QR Code...',
    });

    this.initializations.set(companyId, this.bootstrapClient(companyId));
  }

  // ─── Core Bootstrap ──────────────────────────────────────────────────────────

  private async bootstrapClient(companyId: string): Promise<WppWhatsapp> {
    this.wipeTmpSessionCache(companyId);
    const neonStore = new NeonTokenStore(this.prisma, companyId, this.logger);

    const existingToken = await neonStore.getToken(`company-${companyId}`);
    if (existingToken) {
      this.eventEmitter.emit('whatsapp.session.status', {
        companyId,
        status: 'RESTORING',
        message: 'Restaurando sessão, por favor aguarde...',
      });
      this.statuses.set(companyId, 'Restoring');
      this.startDeadlockTimer(companyId);
    }

    const client = await create({
      session: `company-${companyId}`,
      tokenStore: neonStore,
      headless: true,
      logQR: false,
      updatesLog: false,
      autoClose: 0,
      waitForLogin: false,
      disableWelcome: true,
      folderNameToken: SESSION_BASE_DIR,
      catchQR: (base64Qr: string, _ascii: string, attempt: number) => {
        this.clearDeadlockTimer(companyId);
        const uri = base64Qr.startsWith('data:') ? base64Qr : `data:image/png;base64,${base64Qr}`;
        this.qrCodes.set(companyId, uri);
        this.statuses.set(companyId, 'QR_READY');
        this.eventEmitter.emit('whatsapp.qr.generated', { companyId, qrCode: uri });
        this.eventEmitter.emit('whatsapp.session.status', { companyId, status: 'QR_READY' });
      },
      statusFind: (statusSession: string) => {
        if (statusSession === 'notLogged') this.statuses.set(companyId, 'Awaiting QR');
        else if (statusSession === 'qrReadSuccess') {
          this.statuses.set(companyId, 'Authenticating...');
          this.eventEmitter.emit('whatsapp.session.status', { companyId, status: 'AUTHENTICATING' });
        }
      },
      puppeteerOptions: {
        headless: true,
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/google-chrome',
        args: [`--user-agent=${WHATSAPP_USER_AGENT}`, ...CHROMIUM_ARGS],
      },
    });

    if (!this.initializations.has(companyId) && !this.getClients().has(companyId)) {
      this.clearDeadlockTimer(companyId);
      await client.close().catch(() => null);
      return client;
    }

    this.getClients().set(companyId, client);
    this.initializations.delete(companyId);

    // TASK 1: Immediate Status Check (Reconciliation)
    if (await client.isConnected()) {
      this.logger.log(`[WA-RECONCILE][${companyId}] Session already connected on startup. Forcing state sync.`);
      await this.handleConnectionStateChange('CONNECTED', client, companyId);
    }

    this.attachEventListeners(client, companyId);
    return client;
  }

  // ─── TASK 1 & 2: State Handlers & Listeners ─────────────────────────────────

  private async handleConnectionStateChange(state: string, client: WppWhatsapp, companyId: string) {
    this.logger.log(`[WA-STATE-HANDLER][${companyId}] Processing state → ${state}`);

    switch (state) {
      case 'CONNECTED':
        this.clearDeadlockTimer(companyId);
        this.statuses.set(companyId, 'Connected');
        this.qrCodes.delete(companyId);

        this.eventEmitter.emit('whatsapp.session.connected', { companyId });
        this.eventEmitter.emit('whatsapp.session.status', { companyId, status: 'CONNECTED' });

        // TASK 2: Extract & Persist Profile
        try {
          this.logger.log(`[WA-PROFILE][${companyId}] Extracting host device profile...`);
          const host = await client.getHostDevice() as any;
          const profilePic = await client.getProfilePicFromServer(host.wid?._serialized || host.wid).catch(() => null);
          
          const profileData = {
            whatsappName: host.pushname || host.notifyName || 'Unknown',
            whatsappNumber: host.wid?.user || host.wid || 'Unknown',
            whatsappAvatar: profilePic?.imgFull || null,
          };

          await this.persistProfileData(companyId, profileData);
        } catch (err: unknown) {
          this.logger.warn(`[WA-PROFILE][${companyId}] Failed to sync profile: ${err instanceof Error ? err.message : err}`);
        }

        // TASK 4: Activate AI Message Listener (Only once)
        this.attachMessageListener(client, companyId);
        break;

      case 'CONFLICT':
      case 'UNLAUNCHED':
        this.logger.warn(`[WA-CONFLICT][${companyId}] State ${state} detected. Attempting useHere takeover...`);
        await client.useHere().catch(e => this.logger.error(`[WA-CONFLICT] useHere failed: ${e.message}`));
        break;

      case 'UNPAIRED':
      case 'DISCONNECTED':
        this.clearDeadlockTimer(companyId);
        this.statuses.set(companyId, 'Disconnected');
        this.eventEmitter.emit('whatsapp.session.status', { companyId, status: 'DISCONNECTED' });
        await this.prisma.company.update({
          where: { id: companyId },
          data: { whatsappStatus: 'DISCONNECTED' }
        }).catch(() => null);
        break;
    }
  }

  private async persistProfileData(companyId: string, data: any) {
    this.logger.log(`[WA-PERSIST][${companyId}] Syncing database record for ${data.whatsappName}`);
    await this.prisma.company.update({
      where: { id: companyId },
      data: {
        whatsappName: data.whatsappName,
        whatsappWid: String(data.whatsappNumber),
        whatsappAvatar: data.whatsappAvatar,
        whatsappStatus: 'CONNECTED',
      },
    });
  }

  private attachEventListeners(client: WppWhatsapp, companyId: string): void {
    client.onStateChange(async (state: string) => {
      this.logger.log(`[WA-STATE][${companyId}] onStateChange → ${state}`);
      await this.handleConnectionStateChange(state, client, companyId);
    });

    // If already connected, satisfy TASK 4 immediately
    client.isConnected().then(connected => {
      if (connected) this.attachMessageListener(client, companyId);
    });
  }

  private attachMessageListener(client: any, companyId: string): void {
    if (client.isListenerAttached) return;

    this.logger.log(`[WA-LISTENER][${companyId}] Activating AI Message Listener...`);
    
    client.onMessage(async (message: any) => {
      if (message.isGroupMsg) return;
      if (!message.body) return;

      this.logger.log(`[WA-MSG][${companyId}] Message from ${message.from}`);

      try {
        const company = await this.prisma.company.findUnique({
          where: { id: companyId },
          select: { userId: true },
        });

        if (company?.userId) {
          const aiResponse = await this.chatService.chat(company.userId, {
            companyId,
            message: message.body,
          });

          if (aiResponse.response) {
            await client.sendText(message.from, aiResponse.response);
            this.logger.log(`[WA-AI][${companyId}] Response sent to ${message.from}`);
          }
        }
      } catch (error: unknown) {
        this.logger.error(`[WA-AI][${companyId}] AI execution failed: ${error instanceof Error ? error.message : error}`);
      }

      this.eventEmitter.emit('whatsapp.message.received', {
        companyId,
        from: message.from,
        text: message.body ?? '',
        name: message.sender?.pushname ?? message.sender?.name,
      });
    });

    client.isListenerAttached = true;
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

  // ─── Private Utilities ────────────────────────────────────────────────────────

  private wipeTmpSessionCache(companyId: string): void {
    const sessionDir = path.join(SESSION_BASE_DIR, `company-${companyId}`);
    try {
      if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });
    } catch {}
  }

  private getClients(): Map<string, WppWhatsapp> {
    return (globalThis as GlobalWithWpp).__NEXT_LEVEL_WPP_CLIENTS__!;
  }

  private requireClient(companyId: string): WppWhatsapp {
    const client = this.getClient(companyId);
    if (!client) throw new BadRequestException('WhatsApp não conectado.');
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
    await this.prisma.company.update({
      where: { id: companyId },
      data: { whatsappSessionName: null, whatsappWid: null, whatsappSessionToken: null, whatsappName: null, whatsappStatus: 'DISCONNECTED', whatsappAvatar: null },
    }).catch(() => null);
  }

  private normalizeRecipient(value: string): string {
    const trimmed = value.trim();
    if (!trimmed) throw new BadRequestException('Número obrigatório.');
    if (trimmed.includes('@')) return trimmed;
    const digits = trimmed.replace(/\D/g, '');
    return `${digits}@c.us`;
  }
}
