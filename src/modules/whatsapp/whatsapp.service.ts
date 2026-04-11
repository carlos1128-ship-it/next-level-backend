/**
 * =============================================================================
 * WHATSAPP SERVICE - Hardened for Render multi-tenant production usage
 * =============================================================================
 */

import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  OnApplicationShutdown,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { create, Whatsapp as WhatsappClient } from '@wppconnect-team/wppconnect';
import type {
  SessionToken,
  TokenStore,
} from '@wppconnect-team/wppconnect/dist/token-store/types';
import * as fs from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { PrismaService } from '../../prisma/prisma.service';

export type WhatsappStatus =
  | 'DISCONNECTED'
  | 'CONNECTING'
  | 'QR_READY'
  | 'AUTHENTICATING'
  | 'CONNECTED'
  | 'UNPAIRED';

const SESSION_BASE_DIR = '/tmp/.wppconnect';
const WHATSAPP_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const RENDER_PUPPETEER_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-accelerated-2d-canvas',
  '--no-first-run',
  '--no-zygote',
  '--single-process',
  '--disable-gpu',
  '--disable-extensions',
];
const BROWSER_PATH_CANDIDATES = [
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];
const PUPPETEER_CACHE_ROOTS = [
  path.join(process.cwd(), '.cache', 'puppeteer'),
  '/opt/render/project/src/.cache/puppeteer',
  '/opt/render/.cache/puppeteer',
];
const DEFAULT_RETRY_DELAY_MS = 20000;
const DEFAULT_BOOT_RESTORE_DELAY_MS = process.env.NODE_ENV === 'production' ? 15000 : 0;

class NeonTokenStore implements TokenStore {
  constructor(
    private readonly prisma: PrismaService,
    private readonly companyId: string,
    private readonly logger: Logger,
  ) { }

  async getToken(_sessionName: string): Promise<SessionToken | undefined> {
    try {
      const company = await this.prisma.company.findUnique({
        where: { id: this.companyId },
        select: { whatsappSessionToken: true } as any,
      });

      if (!(company as any)?.whatsappSessionToken) {
        return undefined;
      }

      return JSON.parse((company as any).whatsappSessionToken) as SessionToken;
    } catch (err) {
      this.logger.error(`[WA-TOKEN][${this.companyId}] Failed to read token: ${err}`);
      return undefined;
    }
  }

  async setToken(_sessionName: string, tokenData: SessionToken | null): Promise<boolean> {
    try {
      await this.prisma.company.update({
        where: { id: this.companyId },
        data: { whatsappSessionToken: tokenData ? JSON.stringify(tokenData) : null } as any,
      });
      return true;
    } catch {
      return false;
    }
  }

  async removeToken(_sessionName: string): Promise<boolean> {
    try {
      await this.prisma.company.update({
        where: { id: this.companyId },
        data: { whatsappSessionToken: null } as any,
      });
      return true;
    } catch {
      return false;
    }
  }

  async listTokens(): Promise<string[]> {
    return [`company-${this.companyId}`];
  }
}

@Injectable()
export class WhatsappService
  implements OnModuleInit, OnModuleDestroy, OnApplicationShutdown {
  private readonly logger = new Logger(WhatsappService.name);
  private readonly clients = new Map<string, WhatsappClient>();
  private readonly initializations = new Map<string, Promise<WhatsappClient | null>>();
  private readonly qrCodes = new Map<string, string>();
  private readonly statuses = new Map<string, WhatsappStatus>();
  private readonly retryTimers = new Map<string, NodeJS.Timeout>();
  private readonly manualDisconnects = new Set<string>();
  private readonly restartingSessions = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue('whatsapp-queue') private readonly whatsappQueue: Queue,
  ) { }

  async onModuleInit() {
    if (!this.shouldRestoreSessionsOnBoot()) {
      this.logger.log('Automatic WhatsApp session restore disabled by environment.');
      return;
    }

    const delayMs = this.resolveBootRestoreDelayMs();
    this.logger.log(`Scheduling WhatsApp session restore in ${delayMs}ms...`);

    setTimeout(() => {
      void this.restoreActiveSessions();
    }, delayMs);
  }

  async createSession(companyId: string) {
    this.cancelRetry(companyId);

    if (this.clients.has(companyId)) {
      return {
        status: this.getStatus(companyId),
        qrCode: this.qrCodes.get(companyId),
      };
    }

    if (this.initializations.has(companyId)) {
      return {
        status: this.statuses.get(companyId) || 'CONNECTING',
        qrCode: this.qrCodes.get(companyId),
      };
    }

    this.setStatus(companyId, 'CONNECTING');
    this.initializations.set(companyId, this.bootstrapClient(companyId));
    return { status: 'CONNECTING' };
  }

  async terminateSession(companyId: string): Promise<boolean> {
    this.cancelRetry(companyId);
    this.manualDisconnects.add(companyId);

    try {
      await this.closeClient(companyId, { logout: true, context: 'manual-disconnect' });
      this.cleanupMemory(companyId, 'DISCONNECTED');
      await this.forceCleanup(companyId);

      await (this.prisma.company as any).update({
        where: { id: companyId },
        data: {
          whatsappStatus: 'DISCONNECTED',
          whatsappSessionName: null,
          whatsappWid: null,
          whatsappName: null,
          whatsappAvatar: null,
          whatsappSessionToken: null,
        } as any,
      }).catch(() => null);

      return true;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to terminate session ${companyId}: ${msg}`);
      return false;
    } finally {
      this.manualDisconnects.delete(companyId);
    }
  }

  getStatus(companyId: string): WhatsappStatus {
    return this.statuses.get(companyId) || 'DISCONNECTED';
  }

  getQrCode(companyId: string) {
    return this.qrCodes.get(companyId);
  }

  getClient(companyId: string) {
    return this.clients.get(companyId) || null;
  }

  /**
   * Health check detalhado por sessão — usado pela aba "Atendente Virtual"
   * para verificar estado REAL da conexão, não apenas cache local.
   */
  async getHealthStatus(companyId: string) {
    const client = this.clients.get(companyId);
    const memoryStatus = this.statuses.get(companyId) || 'DISCONNECTED';
    const qrCode = this.qrCodes.get(companyId) || null;
    const hasInitialization = this.initializations.has(companyId);
    const hasRetryTimer = this.retryTimers.has(companyId);

    let isConnected = false;
    let phoneNumber: string | null = null;
    let pushname: string | null = null;
    let lastError: string | null = null;
    let liveStatus = memoryStatus;

    if (client) {
      try {
        isConnected = await client.isConnected();
        const hostDevice = await client.getHostDevice() as any;
        phoneNumber = hostDevice?.wid?.user || null;
        pushname = hostDevice?.pushname || null;

        // Se o cliente está conectado no WPPConnect mas o status de memória é diferente,
        // corrigir o status para evitar dessincronização entre abas
        if (!isConnected && memoryStatus === 'CONNECTED') {
          this.logger.warn(`[WA-HEALTH][${companyId}] Cliente desconectado mas status era CONNECTED. Corrigindo.`);
          liveStatus = 'DISCONNECTED';
          this.statuses.set(companyId, 'DISCONNECTED');
        } else if (isConnected && memoryStatus !== 'CONNECTED') {
          this.logger.log(`[WA-HEALTH][${companyId}] Cliente conectado mas status era ${memoryStatus}. Corrigindo.`);
          liveStatus = 'CONNECTED';
          this.statuses.set(companyId, 'CONNECTED');
        }
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        isConnected = false;
      }
    }

    // Buscar dados do banco para comparação
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: {
        whatsappStatus: true,
        whatsappWid: true,
        whatsappName: true,
        whatsappAvatar: true,
        whatsappEnabled: true,
        lastConnectedAt: true,
      } as any,
    }).catch(() => null);

    const dbStatus = (company as any)?.whatsappStatus || 'DISCONNECTED';
    const dbEnabled = (company as any)?.whatsappEnabled || false;
    const dbLastConnected = (company as any)?.lastConnectedAt || null;

    // Status final é o mais "conectado" entre memória e banco
    const finalStatus = isConnected ? 'CONNECTED' : liveStatus;

    return {
      companyId,
      // Status real (live)
      status: finalStatus,
      connected: finalStatus === 'CONNECTED' && isConnected,
      // Detalhes técnicos
      qrCode,
      phoneNumber,
      pushname,
      hasClient: !!client,
      hasInitialization,
      hasRetryTimer,
      lastError,
      // Dados do banco para comparação
      dbStatus,
      dbEnabled,
      dbLastConnected,
      // Flags de saúde
      healthy: isConnected && finalStatus === 'CONNECTED',
      needsReconnect: !isConnected && dbStatus === 'CONNECTED',
      awaitingQR: !isConnected && (finalStatus === 'QR_READY' || finalStatus === 'CONNECTING'),
    };
  }

  /**
   * Endpoint de cleanup forçado — usado ao trocar de empresa no frontend.
   * Desconecta, limpa memória E arquivos de sessão.
   */
  async forceCleanupSession(companyId: string) {
    this.logger.log(`[WA-CLEANUP-EXTERNAL][${companyId}] Cleanup externo solicitado.`);

    // Cancelar retries pendentes
    this.cancelRetry(companyId);

    // Fechar cliente se existir
    const client = this.clients.get(companyId);
    if (client) {
      await this.closeClient(companyId, { logout: false, context: 'external-cleanup' });
    }

    // Limpar memória
    this.cleanupMemory(companyId, 'DISCONNECTED');

    // Limpar arquivos de sessão
    await this.forceCleanup(companyId);

    // Atualizar banco
    await (this.prisma.company as any).update({
      where: { id: companyId },
      data: { whatsappStatus: 'DISCONNECTED' },
    }).catch(() => null);

    return { success: true, companyId, status: 'DISCONNECTED' };
  }

  async sendTextMessage(companyId: string, externalId: string, message: string) {
    const status = this.getStatus(companyId);
    if (status !== 'CONNECTED' && status !== 'AUTHENTICATING') {
      throw new BadRequestException(`WhatsApp not connected for company ${companyId}`);
    }

    try {
      const job = await this.whatsappQueue.add(
        'sendText',
        {
          companyId,
          to: externalId,
          message,
        },
        {
          attempts: 3,
          backoff: { type: 'exponential', delay: 2000 },
          priority: 1,
          removeOnComplete: true,
          removeOnFail: false,
        },
      );

      return { success: true, messageId: job.id?.toString() };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to enqueue message for ${companyId}: ${msg}`);
      throw new InternalServerErrorException('Failed to process message send');
    }
  }

  async sendBulkMessages(data: {
    companyId: string;
    numbers: string[];
    message: string;
    delayRange?: [number, number];
  }) {
    const { companyId, numbers, message, delayRange = [20000, 40000] } = data;

    if (!this.clients.has(companyId)) {
      throw new BadRequestException('WhatsApp not connected');
    }

    this.logger.log(`[BULK][${companyId}] Queueing bulk send for ${numbers.length} numbers.`);

    let cumulativeDelay = 0;

    for (const number of numbers) {
      const randomDelay =
        Math.floor(Math.random() * (delayRange[1] - delayRange[0] + 1)) + delayRange[0];

      await this.whatsappQueue.add(
        'sendBulkMessage',
        {
          companyId,
          phoneNumber: number,
          message,
        },
        {
          delay: cumulativeDelay,
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
          removeOnComplete: true,
          removeOnFail: false,
        },
      );

      cumulativeDelay += randomDelay;
    }

    return { success: true, count: numbers.length, queued: true };
  }

  async getProfile(companyId: string) {
    const client = this.clients.get(companyId);
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: {
        whatsappStatus: true,
        whatsappWid: true,
        whatsappName: true,
        whatsappAvatar: true,
      } as any,
    });

    let hostDevice: any = null;
    if (client) {
      try {
        hostDevice = await client.getHostDevice();
      } catch {
        hostDevice = null;
      }
    }

    const liveWid =
      hostDevice?.wid?._serialized ||
      (hostDevice?.wid?.user ? `${hostDevice.wid.user}@c.us` : null);

    return {
      status: this.getStatus(companyId) || (company as any)?.whatsappStatus || 'DISCONNECTED',
      wid: liveWid || (company as any)?.whatsappWid || null,
      phoneNumber:
        hostDevice?.wid?.user ||
        ((company as any)?.whatsappWid
          ? String((company as any).whatsappWid).replace('@c.us', '')
          : null),
      name:
        hostDevice?.pushname ||
        hostDevice?.formattedName ||
        hostDevice?.name ||
        (company as any)?.whatsappName ||
        null,
      profilePicUrl: (company as any)?.whatsappAvatar || null,
      raw: hostDevice,
    };
  }

  async checkLiveStatus(companyId: string) {
    const client = this.clients.get(companyId);
    if (!client) {
      return false;
    }

    try {
      const connected = await client.isConnected();
      if (connected) {
        this.cancelRetry(companyId);
        this.setStatus(companyId, 'CONNECTED');
        await this.syncConnectedProfile(companyId, client);
      } else {
        const currentStatus = this.getStatus(companyId);
        if (
          currentStatus === 'QR_READY' ||
          currentStatus === 'AUTHENTICATING' ||
          this.initializations.has(companyId)
        ) {
          return false;
        }

        this.setStatus(companyId, 'DISCONNECTED');
      }

      return connected;
    } catch {
      return false;
    }
  }

  async onModuleDestroy() {
    await this.shutdownAll();
  }

  async onApplicationShutdown() {
    await this.shutdownAll();
  }

  private async restoreActiveSessions() {
    this.logger.log('Restoring active WhatsApp sessions...');

    try {
      // MELHORIA: Restaurar APENAS sessões marcadas como enabled E com lastConnectedAt < 24h
      // Isso evita restore agressivo de sessões antigas ou inválidas
      const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

      const activeCompanies = await (this.prisma.company as any).findMany({
        where: {
          whatsappStatus: 'CONNECTED',
          // Apenas sessões recentes (últimas 24h) para evitar restore de sessões órfãs
          lastConnectedAt: { gte: twentyFourHoursAgo },
        },
        select: { id: true },
      });

      this.logger.log(`Found ${activeCompanies.length} valid sessions to restore (last 24h)`);

      // MELHORIA: Restaurar com delay escalonado para evitar sobrecarga
      for (let i = 0; i < activeCompanies.length; i++) {
        const { id } = activeCompanies[i];
        // Delay de 1s entre cada sessão para não sobrecarregar o Render
        setTimeout(() => {
          this.logger.log(`[WA-RESTORE][${id}] Restoring session (${i + 1}/${activeCompanies.length})`);
          this.createSession(id).catch((err) =>
            this.logger.warn(`[WA-RESTORE][${id}] Failed to restore: ${err.message}`),
          );
        }, i * 1000);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to list active companies for WhatsApp restore: ${msg}`);
    }
  }

  private shouldRestoreSessionsOnBoot() {
    // MELHORIA: Flag para pular restore em ambientes de staging/desenvolvimento
    if (process.env.WHATSAPP_SKIP_RESTORE_ON_BOOT === 'true') {
      this.logger.log('WhatsApp session restore skipped (WHATSAPP_SKIP_RESTORE_ON_BOOT=true)');
      return false;
    }
    return process.env.WHATSAPP_RESTORE_SESSIONS_ON_BOOT !== 'false';
  }

  private async bootstrapClient(companyId: string, recovered = false): Promise<WhatsappClient | null> {
    const neonStore = new NeonTokenStore(this.prisma, companyId, this.logger);
    const sessionName = `company-${companyId}`;

    try {
      this.logger.log(`[WA-INIT][${companyId}] Initializing WPPConnect...`);
      await this.ensureSessionBaseDir();

      const client = await (create as any)({
        session: sessionName,
        tokenStore: neonStore,
        headless: 'new',
        logQR: false,
        updatesLog: false,
        autoClose: 0,
        deviceSyncTimeout: 0,
        waitForLogin: true,
        disableWelcome: true,
        folderNameToken: SESSION_BASE_DIR,
        catchQR: (base64Qr: string, _asciiQr: string, attempts?: number) => {
          this.logger.log(`[QR-CODE][${companyId}] Generated. Attempt: ${attempts ?? 1}`);
          const uri = base64Qr.startsWith('data:')
            ? base64Qr
            : `data:image/png;base64,${base64Qr}`;
          this.qrCodes.set(companyId, uri);
          this.cancelRetry(companyId);
          this.setStatus(companyId, 'QR_READY');
        },
        statusFind: (statusSession: string) => {
          this.handleStatusChange(companyId, statusSession);
        },
        puppeteerOptions: {
          executablePath: this.resolveBrowserExecutablePath(),
          userDataDir: this.getSessionDir(companyId),
          args: [`--user-agent=${WHATSAPP_USER_AGENT}`, ...RENDER_PUPPETEER_ARGS],
        },
      } as any);

      this.clients.set(companyId, client);
      this.initializations.delete(companyId);
      this.qrCodes.delete(companyId);
      this.cancelRetry(companyId);
      this.setStatus(companyId, 'CONNECTED');

      this.setupMessageListener(client, companyId);
      await this.syncConnectedProfile(companyId, client);
      return client;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);

      if (!recovered && this.shouldResetSessionArtifacts(msg)) {
        this.logger.warn(
          `[WA-LOCK][${companyId}] Locked session detected (${msg}). Cleaning artifacts and retrying once...`,
        );
        await this.cleanupStaleSessionFiles(companyId);
        return this.bootstrapClient(companyId, true);
      }

      this.initializations.delete(companyId);

      if (msg.includes('Auto Close Called') || msg.includes('Target.closeTarget')) {
        this.logger.warn(
          `[WA-INIT-RESET][${companyId}] Startup interrupted: ${msg}. Scheduling retry...`,
        );
        this.cleanupMemory(companyId, 'CONNECTING');
        this.scheduleRetry(companyId, 'bootstrap-interrupted');
        return null;
      }

      this.logger.error(`[WA-FATAL][${companyId}] Startup failed: ${msg}`);
      this.cleanupMemory(companyId, 'DISCONNECTED');
      return null;
    }
  }

  private handleStatusChange(companyId: string, status: string) {
    this.logger.log(`[WA-STATUS][${companyId}] ${status}`);

    switch (status) {
      case 'isLogged':
      case 'qrReadSuccess':
      case 'chatsAvailable':
        this.cancelRetry(companyId);
        this.setStatus(companyId, 'CONNECTED');
        break;
      case 'inChat':
      case 'initWhatsapp':
      case 'openBrowser':
      case 'connectBrowserWs':
      case 'waitChat':
        this.cancelRetry(companyId);
        this.setStatus(companyId, 'AUTHENTICATING');
        break;
      case 'notLogged':
        this.cancelRetry(companyId);
        this.setStatus(companyId, 'QR_READY');
        break;
      case 'autocloseCalled':
      case 'qrReadError':
      case 'phoneNotConnected':
        this.setStatus(companyId, 'CONNECTING');
        this.scheduleRetry(companyId, status);
        break;
      case 'disconnectedMobile':
        this.setStatus(companyId, 'UNPAIRED');
        this.scheduleRetry(companyId, status);
        break;
      case 'sessionUnpaired':
        // MELHORIA: Session Unpaired NÃO deve derrubar o processo.
        // Apenas registrar log e permitir retry externo (QR Code manual).
        this.logger.warn(
          `[WA-UNPAIRED][${companyId}] Sessão despareada. Aguardando reconexão manual ou QR Code.`,
        );
        this.setStatus(companyId, 'UNPAIRED', false); // false = não persistir no banco
        break;
      case 'connecting':
      case 'browserClose':
        this.setStatus(companyId, 'CONNECTING');
        break;
      default:
        this.setStatus(companyId, 'DISCONNECTED', false);
        break;
    }

    if (this.statuses.get(companyId) === 'CONNECTED') {
      const client = this.clients.get(companyId);
      if (client) {
        void this.syncConnectedProfile(companyId, client);
      }
    }
  }

  private scheduleRetry(companyId: string, reason: string) {
    if (this.retryTimers.has(companyId)) {
      return;
    }

    const delayMs = this.resolveRetryDelayMs();
    this.logger.warn(`[WA-RETRY][${companyId}] Scheduling retry for ${reason} in ${delayMs}ms...`);

    const retryTimer = setTimeout(() => {
      this.retryTimers.delete(companyId);
      void this.retrySession(companyId, reason);
    }, delayMs);

    this.retryTimers.set(companyId, retryTimer);
  }

  private cancelRetry(companyId: string) {
    const retryTimer = this.retryTimers.get(companyId);
    if (!retryTimer) {
      return;
    }

    clearTimeout(retryTimer);
    this.retryTimers.delete(companyId);
  }

  private async retrySession(companyId: string, reason: string) {
    const currentStatus = this.getStatus(companyId);
    if (
      currentStatus === 'CONNECTED' ||
      currentStatus === 'QR_READY' ||
      currentStatus === 'AUTHENTICATING'
    ) {
      this.logger.log(
        `[WA-RETRY-SKIP][${companyId}] Session already recovered (${currentStatus}). Skipping retry for ${reason}.`,
      );
      return;
    }

    await this.restartSession(companyId, reason);
  }

  private async restartSession(
    companyId: string,
    reason: string,
    forceResetArtifacts = false,
  ) {
    if (this.restartingSessions.has(companyId)) {
      this.logger.warn(
        `[WA-RETRY-SKIP][${companyId}] Restart already in progress. Ignoring ${reason}.`,
      );
      return;
    }

    this.restartingSessions.add(companyId);
    this.logger.warn(`[WA-RETRY-RUN][${companyId}] Restarting session after ${reason}.`);

    try {
      await this.closeClient(companyId, { context: `retry:${reason}` });
      this.cleanupMemory(companyId, 'CONNECTING');

      if (forceResetArtifacts) {
        await this.forceCleanup(companyId);
      }

      await this.createSession(companyId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`[WA-RETRY-FAILED][${companyId}] Failed to restart session: ${msg}`);
      this.setStatus(companyId, 'DISCONNECTED');
    } finally {
      this.restartingSessions.delete(companyId);
    }
  }

  private setupMessageListener(client: WhatsappClient, companyId: string) {
    client.onMessage(async (message: any) => {
      if (message.isGroupMsg || message.fromMe || !message.body) {
        return;
      }

      await this.whatsappQueue.add(
        'processIncomingMessage',
        {
          companyId,
          from: message.from,
          message: message.body,
          name: (message as any).sender?.pushname || (message as any).sender?.name,
        },
        {
          removeOnComplete: true,
          removeOnFail: false,
        },
      );
    });

    client.onStateChange(async (state) => {
      if ((state as any) === 'CONNECTED') {
        this.cancelRetry(companyId);
        this.setStatus(companyId, 'CONNECTED');
        await this.syncConnectedProfile(companyId, client);
        return;
      }

      if ((state as any) === 'DISCONNECTED') {
        if (this.manualDisconnects.has(companyId)) {
          return;
        }

        this.logger.warn(
          `[WA-STATE][${companyId}] Client entered DISCONNECTED. Scheduling safe recovery.`,
        );
        this.setStatus(companyId, 'CONNECTING');
        this.scheduleRetry(companyId, 'client-disconnected');
      }
    });
  }

  private cleanupMemory(companyId: string, nextStatus?: WhatsappStatus) {
    this.clients.delete(companyId);
    this.initializations.delete(companyId);
    this.qrCodes.delete(companyId);

    if (nextStatus) {
      this.statuses.set(companyId, nextStatus);
      return;
    }

    this.statuses.delete(companyId);
  }

  private async ensureSessionBaseDir() {
    await mkdir(SESSION_BASE_DIR, { recursive: true }).catch(() => null);
  }

  private async closeClient(
    companyId: string,
    options: { logout?: boolean; context: string },
  ) {
    const client = this.clients.get(companyId);
    if (!client) {
      return;
    }

    if (options.logout) {
      await client.logout().catch(() => null);
    }

    await client.close().catch((error) => {
      const msg = error instanceof Error ? error.message : String(error);
      if (!msg.includes('Target already closed')) {
        this.logger.warn(`[WA-CLOSE][${companyId}] Failed to close (${options.context}): ${msg}`);
      }
    });
  }

  private resolveBrowserExecutablePath() {
    const configuredPaths = [
      process.env.PUPPETEER_EXECUTABLE_PATH,
      process.env.CHROME_PATH,
    ].filter((value): value is string => Boolean(value?.trim()));

    for (const candidate of [...configuredPaths, ...BROWSER_PATH_CANDIDATES]) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }

    if (configuredPaths.length > 0) {
      this.logger.warn(
        `[WA-BROWSER] No executable found in configured paths: ${configuredPaths.join(', ')}. Falling back to Puppeteer/WPPConnect autodetection.`,
      );
    }

    for (const cacheRoot of PUPPETEER_CACHE_ROOTS) {
      const discoveredPath = this.findBrowserInDirectory(cacheRoot, 4);
      if (discoveredPath) {
        this.logger.log(`[WA-BROWSER] Browser executable found in Puppeteer cache: ${discoveredPath}`);
        return discoveredPath;
      }
    }

    return undefined;
  }

  private findBrowserInDirectory(baseDir: string, depth: number): string | null {
    if (depth < 0 || !fs.existsSync(baseDir)) {
      return null;
    }

    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(baseDir, { withFileTypes: true });
    } catch {
      return null;
    }

    for (const entry of entries) {
      const fullPath = path.join(baseDir, entry.name);

      if (
        entry.isFile() &&
        ['chrome', 'google-chrome', 'google-chrome-stable', 'chromium'].includes(entry.name)
      ) {
        return fullPath;
      }

      if (entry.isDirectory()) {
        const nested = this.findBrowserInDirectory(fullPath, depth - 1);
        if (nested) {
          return nested;
        }
      }
    }

    return null;
  }

  private getSessionDir(companyId: string) {
    return path.posix.join(SESSION_BASE_DIR, `company-${companyId}`);
  }

  private async cleanupStaleSessionFiles(companyId: string) {
    await this.forceCleanup(companyId);
  }

  private async forceCleanup(companyId: string) {
    const sessionPath = this.getSessionDir(companyId);
    this.logger.log(`[WA-CLEANUP][${companyId}] Heavy cleanup in ${sessionPath}`);

    try {
      if (fs.existsSync(sessionPath)) {
        fs.rmSync(sessionPath, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 1000,
        });
        this.logger.log(`[WA-CLEANUP][${companyId}] Session folder removed.`);
      }
      return;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.warn(`[WA-CLEANUP][${companyId}] Initial delete failed: ${msg}`);
    }

    try {
      if (!fs.existsSync(sessionPath)) {
        return;
      }

      const tempPath = `${sessionPath}-old-${Date.now()}`;
      fs.renameSync(sessionPath, tempPath);
      fs.rmSync(tempPath, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 1000,
      });
      this.logger.log(`[WA-CLEANUP][${companyId}] Session folder renamed and removed.`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`[WA-FATAL][${companyId}] Unable to clean session folder: ${msg}`);
    }
  }

  private shouldResetSessionArtifacts(message: string) {
    const normalized = message.toLowerCase();
    return (
      normalized.includes('browser is already running') ||
      normalized.includes('singletonlock') ||
      normalized.includes('singletonsocket') ||
      normalized.includes('singletoncookie') ||
      normalized.includes('lock file') ||
      normalized.includes('target closed') ||
      normalized.includes('failed to launch the browser process')
    );
  }

  private setStatus(companyId: string, status: WhatsappStatus, persist = true) {
    this.statuses.set(companyId, status);

    if (!persist) {
      return;
    }

    void (this.prisma.company as any).update({
      where: { id: companyId },
      data: { whatsappStatus: status },
    }).catch(() => null);
  }

  private resolveRetryDelayMs() {
    const raw = Number(process.env.WHATSAPP_RETRY_DELAY_MS ?? DEFAULT_RETRY_DELAY_MS);
    return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_RETRY_DELAY_MS;
  }

  private resolveBootRestoreDelayMs() {
    const raw = Number(
      process.env.WHATSAPP_BOOT_RESTORE_DELAY_MS ?? DEFAULT_BOOT_RESTORE_DELAY_MS,
    );
    return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_BOOT_RESTORE_DELAY_MS;
  }

  private async syncConnectedProfile(companyId: string, client: WhatsappClient) {
    try {
      const hostDevice = (await client.getHostDevice()) as any;
      const wid =
        hostDevice?.wid?._serialized ||
        (hostDevice?.wid?.user ? `${hostDevice.wid.user}@c.us` : null);
      const phoneNumber = hostDevice?.wid?.user || null;
      const displayName =
        hostDevice?.pushname || hostDevice?.formattedName || hostDevice?.name || phoneNumber;

      let avatarUrl: string | null = null;
      if (wid) {
        try {
          const profilePic = await client.getProfilePicFromServer(wid);
          avatarUrl =
            (profilePic as any)?.eurl ||
            (profilePic as any)?.imgFull ||
            (profilePic as any)?.img ||
            null;
        } catch {
          avatarUrl = null;
        }
      }

      await (this.prisma.company as any).update({
        where: { id: companyId },
        data: {
          whatsappStatus: 'CONNECTED',
          whatsappSessionName: `company-${companyId}`,
          whatsappWid: wid,
          whatsappName: displayName,
          whatsappAvatar: avatarUrl,
        },
      }).catch(() => null);

      this.logger.log(
        `[WA-PROFILE][${companyId}] Profile synced (${displayName || 'no-name'} / ${phoneNumber || 'no-number'})`,
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.warn(`[WA-PROFILE][${companyId}] Failed to sync profile: ${msg}`);
    }
  }

  private async shutdownAll() {
    this.logger.log('Shutting down WhatsApp instances...');

    for (const retryTimer of this.retryTimers.values()) {
      clearTimeout(retryTimer);
    }
    this.retryTimers.clear();

    for (const client of this.clients.values()) {
      try {
        await client.close();
      } catch {
        // Ignore shutdown errors.
      }
    }
  }
}
