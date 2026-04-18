import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { create, Whatsapp as WppWhatsapp } from '@wppconnect-team/wppconnect';
import { IntegrationProvider } from '@prisma/client';
import * as fs from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { PrismaService } from '../../prisma/prisma.service';

type WhatsappStatus =
  | 'DISCONNECTED'
  | 'CONNECTING'
  | 'QR_READY'
  | 'QR_REQUIRED'
  | 'AUTHENTICATING'
  | 'CONNECTED'
  | 'UNPAIRED';

type IncomingMessageShape = {
  isGroupMsg?: boolean;
  fromMe?: boolean;
  body?: string;
  from?: string;
  type?: string;
  sender?: {
    pushname?: string;
    name?: string;
  };
};

type HostWidShape = {
  _serialized?: string;
  user?: string;
};

type HostDeviceShape = {
  wid?: string | HostWidShape;
  pushname?: string;
  formattedName?: string;
  name?: string;
};

const SESSION_BASE_DIR =
  process.env.WPPCONNECT_SESSION_DIR || '/tmp/.wppconnect';
const TOKEN_BASE_DIR =
  process.env.WPPCONNECT_TOKEN_DIR || '/tmp/tokens';
const DEFAULT_RETRY_DELAY_MS = 20000;
const QR_REUSE_WINDOW_MS = 60000;
const WHATSAPP_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
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
  '--disable-software-rasterizer',
  '--disable-background-networking',
  '--disable-sync',
  '--disable-translate',
  '--hide-scrollbars',
  '--metrics-recording-only',
  '--mute-audio',
  '--safebrowsing-disable-auto-update',
  '--no-default-browser-check',
];
const COMMON_BROWSER_PATHS = [
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
];
const PUPPETEER_CACHE_ROOTS = [
  '/opt/render/.cache/puppeteer',
  '/opt/render/project/.cache/puppeteer',
  '/opt/render/project/src/.cache/puppeteer',
  path.join(process.cwd(), '.cache', 'puppeteer'),
];

@Injectable()
export class WppconnectService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WppconnectService.name);
  private readonly clients = new Map<string, WppWhatsapp>();
  private readonly initializations = new Map<string, Promise<WppWhatsapp | null>>();
  private readonly initializationSessions = new Map<string, string>();
  private readonly qrCodes = new Map<string, string>();
  private readonly statuses = new Map<string, WhatsappStatus>();
  private readonly retryTimers = new Map<string, NodeJS.Timeout>();
  private readonly manualDisconnects = new Set<string>();
  private readonly needsQrScan = new Set<string>();
  private readonly qrTimestamps = new Map<string, number>();
  private readonly sessionNames = new Map<string, string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async onModuleInit() {
    await this.restoreActiveSessions();
  }

  async onModuleDestroy() {
    for (const companyId of this.retryTimers.keys()) {
      this.cancelRetry(companyId);
    }

    for (const [companyId, client] of this.clients.entries()) {
      await client.close().catch(() => null);
      this.cleanupMemory(companyId, { clearSessionName: true });
    }
  }

  async createSession(companyId: string, options?: { fresh?: boolean }) {
    this.needsQrScan.delete(companyId);
    let sessionName: string;

    if (options?.fresh) {
      this.logger.warn(`[WPP][${companyId}] Forcando nova sessao com limpeza total de tokens.`);
      await this.clearPersistedSessionState(companyId);
      await this.sleep(2000);
      sessionName = this.buildFreshSessionName(companyId);
    } else {
      sessionName = await this.resolveSessionName(companyId);
    }

    this.sessionNames.set(companyId, sessionName);
    this.setStatus(companyId, 'CONNECTING');
    this.logger.log(`[WPP][${companyId}] Iniciando sessao: ${sessionName}`);

    await this.ensureSessionBaseDir();
    await this.prisma.company.update({
      where: { id: companyId },
      data: {
        whatsappEnabled: true,
        whatsappStatus: 'CONNECTING',
        whatsappSessionName: sessionName,
      },
    });

    if (!options?.fresh && this.clients.has(companyId)) {
      return {
        status: this.getStatus(companyId),
        qrcode: this.getQrCode(companyId),
        qrCode: this.getQrCode(companyId),
        ready: Boolean(this.getQrCode(companyId)),
      };
    }

    if (
      !this.initializations.has(companyId) ||
      this.initializationSessions.get(companyId) !== sessionName
    ) {
      this.initializationSessions.set(companyId, sessionName);
      this.initializations.set(companyId, this.bootstrapClient(companyId, sessionName));
    }

    return {
      status: this.getStatus(companyId),
      qrcode: this.getQrCode(companyId),
      qrCode: this.getQrCode(companyId),
      ready: Boolean(this.getQrCode(companyId)),
    };
  }

  async terminateSession(companyId: string) {
    this.manualDisconnects.add(companyId);
    this.cancelRetry(companyId);

    const client = this.clients.get(companyId);
    if (client) {
      await client.logout().catch(() => null);
      await client.close().catch(() => null);
    }

    this.cleanupMemory(companyId, { clearSessionName: true });
    await this.forceCleanupFiles(companyId);
    await this.forceCleanupTokenFiles(companyId);
    await this.prisma.company.update({
      where: { id: companyId },
      data: {
        whatsappStatus: 'DISCONNECTED',
        whatsappEnabled: false,
        whatsappSessionName: null,
        whatsappSessionToken: null,
        whatsappWid: null,
        whatsappName: null,
        whatsappAvatar: null,
      },
    });
    await this.syncIntegrationStatus(companyId, 'disconnected');

    this.manualDisconnects.delete(companyId);

    return { success: true };
  }

  getStatus(companyId: string): WhatsappStatus {
    return this.statuses.get(companyId) || 'DISCONNECTED';
  }

  getQrCode(companyId: string) {
    return this.qrCodes.get(companyId) || null;
  }

  getClient(companyId: string) {
    return this.clients.get(companyId) || null;
  }

  async sendTextMessage(companyId: string, to: string, message: string) {
    const client = this.clients.get(companyId);
    if (!client) {
      throw new Error('WhatsApp nao conectado para esta empresa.');
    }

    await client.sendText(this.normalizeRecipient(to), message);
    return { sent: true };
  }

  async getHealthStatus(companyId: string) {
    const client = this.clients.get(companyId) || null;
    const dbCompany = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: {
        whatsappStatus: true,
        whatsappEnabled: true,
        whatsappWid: true,
        whatsappName: true,
        lastConnectedAt: true,
      },
    });

    let connected = false;
    let authenticated = false;
    let connectionState: string | null = null;
    let phoneNumber: string | null = null;
    let pushname: string | null = null;
    let lastError: string | null = null;

    if (client) {
      try {
        const [clientConnected, isAuthenticated, state] = await Promise.all([
          client.isConnected(),
          client.isAuthenticated(),
          client.getConnectionState(),
        ]);
        authenticated = isAuthenticated;
        connectionState = state ? String(state) : null;
        connected = Boolean(clientConnected && isAuthenticated);
        const host = (await client.getHostDevice()) as HostDeviceShape | undefined;
        phoneNumber = this.extractPhoneNumber(host);
        pushname = this.extractDisplayName(host, phoneNumber);
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }

    const qrCode = this.getQrCode(companyId);
    const status = connected ? 'CONNECTED' : this.getStatus(companyId);
    const qrRequired =
      !connected &&
      (this.needsQrScan.has(companyId) ||
        status === 'QR_REQUIRED' ||
        status === 'UNPAIRED');
    const awaitingQR = !connected && (status === 'QR_READY' || Boolean(qrCode));

    return {
      companyId,
      status,
      connected,
      authenticated,
      connectionState,
      qrCode,
      phoneNumber,
      pushname,
      hasClient: Boolean(client),
      hasInitialization: this.initializations.has(companyId),
      hasRetryTimer: this.retryTimers.has(companyId),
      lastError,
      dbStatus: dbCompany?.whatsappStatus || 'DISCONNECTED',
      dbEnabled: Boolean(dbCompany?.whatsappEnabled),
      dbLastConnected: dbCompany?.lastConnectedAt?.toISOString() || null,
      healthy: connected,
      needsReconnect:
        !connected &&
        dbCompany?.whatsappStatus === 'CONNECTED' &&
        !this.needsQrScan.has(companyId),
      awaitingQR,
      qrRequired,
    };
  }

  async forceCleanupSession(companyId: string) {
    this.cancelRetry(companyId);
    const client = this.clients.get(companyId);
    if (client) {
      await client.close().catch(() => null);
    }

    this.cleanupMemory(companyId, { clearSessionName: true });
    await this.forceCleanupFiles(companyId);
    await this.forceCleanupTokenFiles(companyId);
    await this.prisma.company.update({
      where: { id: companyId },
      data: {
        whatsappStatus: 'DISCONNECTED',
        whatsappEnabled: false,
        whatsappSessionName: null,
        whatsappSessionToken: null,
        whatsappWid: null,
        whatsappName: null,
        whatsappAvatar: null,
      },
    }).catch(() => null);
    await this.syncIntegrationStatus(companyId, 'disconnected');

    return { success: true, companyId, status: 'DISCONNECTED' };
  }

  private async restoreActiveSessions() {
    const recentThreshold = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const companies = await this.prisma.company.findMany({
      where: {
        whatsappStatus: 'CONNECTED',
        lastConnectedAt: { gte: recentThreshold },
      },
      select: { id: true, whatsappSessionName: true },
    });

    for (const [index, company] of companies.entries()) {
      const sessionName =
        company.whatsappSessionName || this.buildCompanySessionPrefix(company.id);
      if (!this.hasPersistedSessionData(company.id, sessionName)) {
        this.logger.warn(
          `[WPP][${company.id}] Sessao marcada como conectada, mas sem tokens locais. Ignorando restauracao.`,
        );
        continue;
      }
      this.sessionNames.set(company.id, sessionName);
      setTimeout(() => {
        void this.createSession(company.id);
      }, index * 1000);
    }
  }

  private async bootstrapClient(companyId: string, sessionName: string): Promise<WppWhatsapp | null> {
    const executablePath = this.resolveBrowserExecutablePath();

    try {
      await this.forceCleanupFiles(companyId, sessionName);
      this.setStatus(companyId, 'CONNECTING');

      if (executablePath) {
        this.logger.log(`[WA-BROWSER][${companyId}] Usando browser em: ${executablePath}`);
      } else {
        this.logger.warn(
          `[WA-BROWSER][${companyId}] Nenhum executavel de Chrome/Chromium foi localizado. ` +
            'Se estiver no Render Node runtime, adicione `npx puppeteer browsers install chrome` ao build.',
        );
      }

      const client = await create({
        session: sessionName,
        tokenStore: 'file',
        headless: this.resolveHeadless(),
        devtools: false,
        useChrome: false,
        debug: false,
        logQR: true,
        updatesLog: true,
        browserWS: '',
        browserArgs: CHROMIUM_ARGS,
        autoClose: 0,
        waitForLogin: false,
        disableWelcome: true,
        folderNameToken: TOKEN_BASE_DIR,
        mkdirFolderToken: TOKEN_BASE_DIR,
        catchQR: (base64Qr, _asciiQR, attempts) => {
          if (!this.isActiveSession(companyId, sessionName)) {
            this.logger.warn(
              `[WPP][${companyId}] Ignorando QR de sessao antiga: ${sessionName}`,
            );
            return;
          }

          const now = Date.now();
          const previousQr = this.qrCodes.get(companyId);
          const previousTimestamp = this.qrTimestamps.get(companyId) || 0;
          const qrCode = base64Qr.startsWith('data:')
            ? base64Qr
            : `data:image/png;base64,${base64Qr}`;

          if (previousQr && now - previousTimestamp < QR_REUSE_WINDOW_MS) {
            return;
          }

          this.qrCodes.set(companyId, qrCode);
          this.qrTimestamps.set(companyId, now);
          this.setStatus(companyId, 'QR_READY');
          this.logger.log(
            `[WPP][${companyId}] QR gerado com sucesso. Tentativa ${attempts ?? 1}. Sessao ${sessionName}`,
          );
          void this.syncIntegrationStatus(companyId, 'awaiting_qr_scan', sessionName);
          this.eventEmitter.emit('whatsapp.qr.generated', {
            companyId,
            qrCode,
            attempts: attempts ?? 1,
            sessionName,
          });
        },
        statusFind: (statusSession: string) => {
          if (!this.isActiveSession(companyId, sessionName)) {
            this.logger.warn(
              `[WPP][${companyId}] Ignorando status de sessao antiga ${sessionName}: ${statusSession}`,
            );
            return;
          }
          void this.handleStatusChange(companyId, statusSession, sessionName);
        },
        puppeteerOptions: {
          headless: this.resolveHeadless(),
          protocolTimeout: 120000,
          args: CHROMIUM_ARGS,
          executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || executablePath || undefined,
        },
      });

      if (!this.isActiveSession(companyId, sessionName)) {
        this.logger.warn(
          `[WPP][${companyId}] Cliente antigo iniciado fora de hora. Fechando sessao ${sessionName}.`,
        );
        await client.close().catch(() => null);
        this.clearInitialization(companyId, sessionName);
        return null;
      }

      this.clients.set(companyId, client);
      this.clearInitialization(companyId, sessionName);
      this.attachEventListeners(client, companyId, sessionName);
      return client;
    } catch (error) {
      this.clearInitialization(companyId, sessionName);
      this.cleanupMemory(companyId, { sessionName });
      this.setStatus(companyId, 'DISCONNECTED');
      await this.syncIntegrationStatus(companyId, 'disconnected', sessionName);

      const message = this.formatBootstrapError(error);
      this.logger.error(`[WA-FATAL][${companyId}] Falha ao iniciar WPPConnect: ${message}`);
      this.scheduleRetry(companyId);
      return null;
    }
  }

  private attachEventListeners(client: WppWhatsapp, companyId: string, sessionName: string) {
    client.onStateChange((state: string) => {
      if (state === 'CONNECTED') {
        this.cancelRetry(companyId);
        this.needsQrScan.delete(companyId);
        this.qrCodes.delete(companyId);
        this.qrTimestamps.delete(companyId);
        this.setStatus(companyId, 'CONNECTED');
        void this.syncConnectedProfile(companyId, client, sessionName);
        return;
      }

      if (state === 'DISCONNECTED' && !this.manualDisconnects.has(companyId)) {
        void this.handleClientDisconnect(companyId, sessionName, 'DISCONNECTED');
      }
    });

    client.onMessage((message: IncomingMessageShape) => {
      if (
        message.isGroupMsg ||
        message.fromMe ||
        !message.body ||
        !message.from ||
        (message.type && message.type !== 'chat')
      ) {
        return;
      }

      this.eventEmitter.emit('whatsapp.message.received', {
        companyId,
        from: message.from,
        text: message.body,
        name: message.sender?.pushname || message.sender?.name,
      });
    });
  }

  private async handleStatusChange(companyId: string, statusSession: string, sessionName: string) {
    this.logger.log(`[WPP][${companyId}] Status: ${statusSession}`);
    this.eventEmitter.emit('whatsapp.status.updated', {
      companyId,
      status: statusSession,
    });

    switch (statusSession) {
      case 'isLogged':
      case 'inChat':
      case 'chatsAvailable':
      case 'qrReadSuccess':
        this.cancelRetry(companyId);
        this.needsQrScan.delete(companyId);
        this.qrCodes.delete(companyId);
        this.qrTimestamps.delete(companyId);
        this.setStatus(companyId, 'CONNECTED');
        void this.syncIntegrationStatus(companyId, 'connected', sessionName);
        return;
      case 'notLogged':
        await this.handleQrRequired(companyId, sessionName, statusSession);
        return;
      case 'initWhatsapp':
      case 'openBrowser':
      case 'connectBrowserWs':
      case 'waitChat':
      case 'connecting':
        this.setStatus(companyId, 'AUTHENTICATING');
        return;
      case 'sessionUnpaired':
        this.setStatus(companyId, 'UNPAIRED');
        await this.handleQrRequired(companyId, sessionName, statusSession);
        return;
      case 'serverClose':
      case 'browserClose':
      case 'autocloseCalled':
        if (this.needsQrScan.has(companyId)) {
          this.logger.warn(
            `[WPP][${companyId}] ${statusSession} apos desconexao do usuario. Ignorando reconnect.`,
          );
          return;
        }
        await this.handleClientDisconnect(companyId, sessionName, 'DISCONNECTED', 10000);
        return;
      case 'deleteToken':
      case 'desconnectedMobile':
      case 'disconnectedMobile':
        await this.handleQrRequired(companyId, sessionName, statusSession);
        return;
      case 'phoneNotConnected':
      case 'qrReadError':
      default:
        await this.handleClientDisconnect(companyId, sessionName, 'DISCONNECTED', 10000);
    }
  }

  private scheduleRetry(companyId: string, delayMs = this.resolveRetryDelayMs()) {
    if (this.retryTimers.has(companyId) || this.manualDisconnects.has(companyId)) {
      return;
    }

    const timer = setTimeout(() => {
      this.retryTimers.delete(companyId);
      if (!this.clients.has(companyId) && !this.initializations.has(companyId)) {
        const sessionName =
          this.sessionNames.get(companyId) || this.buildCompanySessionPrefix(companyId);
        this.initializationSessions.set(companyId, sessionName);
        this.initializations.set(companyId, this.bootstrapClient(companyId, sessionName));
      }
    }, delayMs);

    this.retryTimers.set(companyId, timer);
  }

  private cancelRetry(companyId: string) {
    const timer = this.retryTimers.get(companyId);
    if (!timer) return;
    clearTimeout(timer);
    this.retryTimers.delete(companyId);
  }

  private cleanupMemory(
    companyId: string,
    options?: {
      sessionName?: string;
      clearSessionName?: boolean;
    },
  ) {
    if (
      options?.sessionName &&
      this.sessionNames.has(companyId) &&
      this.sessionNames.get(companyId) !== options.sessionName
    ) {
      return;
    }

    this.clients.delete(companyId);
    this.clearInitialization(companyId, options?.sessionName);
    this.qrCodes.delete(companyId);
    this.qrTimestamps.delete(companyId);
    this.statuses.delete(companyId);

    if (options?.clearSessionName) {
      this.sessionNames.delete(companyId);
    }
  }

  private async handleClientDisconnect(
    companyId: string,
    sessionName: string,
    status: WhatsappStatus,
    retryDelayMs = this.resolveRetryDelayMs(),
  ) {
    if (this.manualDisconnects.has(companyId)) {
      return;
    }

    const client = this.clients.get(companyId);
    if (client) {
      await client.close().catch(() => null);
    }

    this.cleanupMemory(companyId, { sessionName });
    this.setStatus(companyId, status);
    await this.syncIntegrationStatus(companyId, 'disconnected', sessionName);
    this.scheduleRetry(companyId, retryDelayMs);
  }

  async clearSession(companyId: string) {
    try {
      this.manualDisconnects.add(companyId);
      this.cancelRetry(companyId);

      const client = this.clients.get(companyId);
      if (client) {
        await client.close().catch(() => null);
      }

      this.cleanupMemory(companyId, { clearSessionName: true });
      this.deletePersistedSessionPaths(companyId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`[WPP][${companyId}] Erro ao limpar sessao: ${message}`);
    } finally {
      this.manualDisconnects.delete(companyId);
    }
  }

  private async syncConnectedProfile(companyId: string, client: WppWhatsapp, sessionName: string) {
    try {
      const host = (await client.getHostDevice()) as HostDeviceShape | undefined;
      const wid = this.extractWid(host);
      const phoneNumber = this.extractPhoneNumber(host);
      const displayName = this.extractDisplayName(host, phoneNumber);

      await this.prisma.company.update({
        where: { id: companyId },
        data: {
          whatsappStatus: 'CONNECTED',
          whatsappEnabled: true,
          whatsappSessionName: sessionName,
          whatsappWid: wid,
          whatsappName: displayName,
          lastConnectedAt: new Date(),
        },
      });

      await this.syncIntegrationStatus(companyId, 'connected', sessionName);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`[WA-PROFILE][${companyId}] Falha ao sincronizar perfil: ${message}`);
    }
  }

  private async syncIntegrationStatus(
    companyId: string,
    status: string,
    externalId?: string,
  ) {
    await this.prisma.integration.upsert({
      where: {
        companyId_provider: {
          companyId,
          provider: IntegrationProvider.WHATSAPP,
        },
      },
      update: {
        status,
        externalId: externalId || undefined,
        accessToken: externalId || 'wppconnect-session',
      },
      create: {
        companyId,
        provider: IntegrationProvider.WHATSAPP,
        status,
        externalId: externalId || `company-${companyId}`,
        accessToken: externalId || 'wppconnect-session',
      },
    }).catch(() => null);
  }

  private setStatus(companyId: string, status: WhatsappStatus) {
    this.statuses.set(companyId, status);
    void this.prisma.company.update({
      where: { id: companyId },
      data: { whatsappStatus: status },
    }).catch(() => null);
  }

  private async ensureSessionBaseDir() {
    await mkdir(SESSION_BASE_DIR, { recursive: true }).catch(() => null);
  }

  private async forceCleanupFiles(companyId: string, sessionName?: string) {
    const directories = this.collectPersistedDirectories(
      this.getSessionRoots(),
      companyId,
      sessionName,
    );
    this.removeDirectories(companyId, directories, 'sessao');
  }

  private async forceCleanupTokenFiles(companyId: string, sessionName?: string) {
    const directories = this.collectPersistedDirectories(
      this.getTokenRoots(),
      companyId,
      sessionName,
    );
    this.removeDirectories(companyId, directories, 'token');
  }

  private async clearPersistedSessionState(companyId: string) {
    this.manualDisconnects.add(companyId);
    this.cancelRetry(companyId);

    const client = this.clients.get(companyId);
    if (client) {
      await client.logout().catch(() => null);
      await client.close().catch(() => null);
    }

    this.cleanupMemory(companyId, { clearSessionName: true });
    this.deletePersistedSessionPaths(companyId);

    await this.prisma.company.update({
      where: { id: companyId },
      data: {
        whatsappStatus: 'DISCONNECTED',
        whatsappEnabled: false,
        whatsappSessionName: null,
        whatsappSessionToken: null,
        whatsappWid: null,
        whatsappName: null,
        whatsappAvatar: null,
      },
    }).catch(() => null);
    await this.syncIntegrationStatus(companyId, 'disconnected');

    this.manualDisconnects.delete(companyId);
  }

  private deletePersistedSessionPaths(companyId: string, sessionName?: string) {
    const allDirectories = [
      ...this.collectPersistedDirectories(this.getTokenRoots(), companyId, sessionName),
      ...this.collectPersistedDirectories(this.getSessionRoots(), companyId, sessionName),
    ];
    this.removeDirectories(companyId, allDirectories, 'arquivo');
  }

  private async handleQrRequired(
    companyId: string,
    sessionName: string,
    rawStatus: string,
  ) {
    this.needsQrScan.add(companyId);
    this.logger.warn(
      `[WPP][${companyId}] Dispositivo desconectado pelo usuario (${rawStatus}). Novo QR obrigatorio.`,
    );
    this.logger.warn(
      `[WPP][${companyId}] Antes do novo teste, remova todos os aparelhos conectados no WhatsApp do celular.`,
    );

    await this.clearSession(companyId);
    this.setStatus(companyId, 'QR_REQUIRED');
    await this.prisma.company.update({
      where: { id: companyId },
      data: {
        whatsappStatus: 'QR_REQUIRED',
        whatsappEnabled: false,
        whatsappSessionName: null,
        whatsappSessionToken: null,
        whatsappWid: null,
        whatsappName: null,
        whatsappAvatar: null,
      },
    }).catch(() => null);
    await this.syncIntegrationStatus(companyId, 'awaiting_qr_scan', sessionName);
    this.eventEmitter.emit('whatsapp.status.updated', {
      companyId,
      status: 'qrRequired',
    });
  }

  private normalizeRecipient(value: string) {
    const trimmed = value.trim();
    if (trimmed.includes('@')) {
      return trimmed;
    }

    const digits = trimmed.replace(/\D/g, '');
    return `${digits}@c.us`;
  }

  private resolveRetryDelayMs() {
    const parsed = Number(process.env.WHATSAPP_RETRY_DELAY_MS ?? DEFAULT_RETRY_DELAY_MS);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_RETRY_DELAY_MS;
  }

  private resolveHeadless(): boolean | 'shell' {
    const raw = (process.env.WPPCONNECT_HEADLESS ?? 'true').trim().toLowerCase();
    if (raw === 'shell') {
      return 'shell';
    }
    return raw !== 'false';
  }

  private extractWid(host: HostDeviceShape | undefined) {
    if (!host?.wid) return null;
    if (typeof host.wid === 'string') return host.wid;
    if (host.wid._serialized) return host.wid._serialized;
    if (host.wid.user) return `${host.wid.user}@c.us`;
    return null;
  }

  private extractPhoneNumber(host: HostDeviceShape | undefined) {
    if (!host?.wid) return null;
    if (typeof host.wid === 'string') {
      return host.wid.replace('@c.us', '');
    }
    return host.wid.user || null;
  }

  private extractDisplayName(host: HostDeviceShape | undefined, phoneNumber: string | null) {
    return host?.pushname || host?.formattedName || host?.name || phoneNumber || null;
  }

  private buildCompanySessionPrefix(companyId: string) {
    return `company-${companyId}`;
  }

  private buildFreshSessionName(companyId: string) {
    return `${this.buildCompanySessionPrefix(companyId)}-${Date.now()}`;
  }

  private async resolveSessionName(companyId: string) {
    const cached = this.sessionNames.get(companyId);
    if (cached) {
      return cached;
    }

    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { whatsappSessionName: true },
    });
    const resolved = company?.whatsappSessionName || this.buildCompanySessionPrefix(companyId);
    this.sessionNames.set(companyId, resolved);
    return resolved;
  }

  private clearInitialization(companyId: string, sessionName?: string) {
    const currentSession = this.initializationSessions.get(companyId);
    if (sessionName && currentSession && currentSession !== sessionName) {
      return;
    }

    this.initializations.delete(companyId);
    this.initializationSessions.delete(companyId);
  }

  private isActiveSession(companyId: string, sessionName: string) {
    return this.sessionNames.get(companyId) === sessionName;
  }

  private hasPersistedSessionData(companyId: string, sessionName?: string) {
    return [
      ...this.collectPersistedDirectories(this.getTokenRoots(), companyId, sessionName),
      ...this.collectPersistedDirectories(this.getSessionRoots(), companyId, sessionName),
    ].some((currentPath) => fs.existsSync(currentPath));
  }

  private getSessionRoots() {
    return this.uniquePaths([
      SESSION_BASE_DIR,
      '/tmp/.wppconnect',
      path.join(process.cwd(), '.wppconnect'),
    ]);
  }

  private getTokenRoots() {
    return this.uniquePaths([
      TOKEN_BASE_DIR,
      '/tmp/tokens',
      path.join(process.cwd(), 'tokens'),
    ]);
  }

  private uniquePaths(paths: Array<string | undefined>) {
    return [...new Set(paths.filter((value): value is string => Boolean(value)))];
  }

  private collectPersistedDirectories(
    roots: string[],
    companyId: string,
    sessionName?: string,
  ) {
    const prefix = this.buildCompanySessionPrefix(companyId);
    const directories = new Set<string>();

    for (const root of roots) {
      if (!root) {
        continue;
      }

      directories.add(path.join(root, prefix));
      directories.add(path.join(root, companyId));

      if (sessionName) {
        directories.add(path.join(root, sessionName));
      }

      if (!fs.existsSync(root)) {
        continue;
      }

      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) {
          continue;
        }

        if (this.matchesCompanySessionEntry(entry.name, companyId)) {
          directories.add(path.join(root, entry.name));
        }
      }
    }

    return [...directories];
  }

  private matchesCompanySessionEntry(entryName: string, companyId: string) {
    const prefix = this.buildCompanySessionPrefix(companyId);
    return (
      entryName === companyId ||
      entryName === prefix ||
      entryName.startsWith(`${prefix}-`)
    );
  }

  private removeDirectories(companyId: string, directories: string[], label: string) {
    const uniqueDirectories = [...new Set(directories)];

    for (const currentPath of uniqueDirectories) {
      try {
        if (!fs.existsSync(currentPath)) {
          continue;
        }

        this.logger.warn(`[WPP][${companyId}] Limpando ${label}: ${currentPath}`);
        fs.rmSync(currentPath, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 500,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(`[WPP][${companyId}] Nao foi possivel limpar ${currentPath}: ${message}`);
      }
    }
  }

  private resolveBrowserExecutablePath() {
    const envCandidates = [
      process.env.PUPPETEER_EXECUTABLE_PATH,
      process.env.CHROME_PATH,
    ];

    for (const candidate of [...envCandidates, ...COMMON_BROWSER_PATHS]) {
      if (candidate && fs.existsSync(candidate)) {
        return candidate;
      }
    }

    const puppeteerExecutable = this.resolvePuppeteerExecutablePath();
    if (puppeteerExecutable) {
      return puppeteerExecutable;
    }

    return this.findBrowserInCache();
  }

  private resolvePuppeteerExecutablePath() {
    try {
      // Usa o caminho calculado pelo proprio Puppeteer quando o browser foi baixado no build.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const puppeteer = require('puppeteer') as { executablePath?: () => string };
      const executablePath = puppeteer.executablePath?.();
      if (executablePath && fs.existsSync(executablePath)) {
        return executablePath;
      }
    } catch {
      return undefined;
    }

    return undefined;
  }

  private findBrowserInCache() {
    for (const cacheRoot of PUPPETEER_CACHE_ROOTS) {
      if (!fs.existsSync(cacheRoot)) {
        continue;
      }

      const executable = this.findExecutableRecursively(cacheRoot, 4);
      if (executable) {
        return executable;
      }
    }

    return undefined;
  }

  private findExecutableRecursively(directory: string, depth: number): string | undefined {
    if (depth < 0 || !fs.existsSync(directory)) {
      return undefined;
    }

    const executableName =
      process.platform === 'win32' ? 'chrome.exe' : undefined;
    const linuxCandidates = ['chrome', 'chrome-headless-shell'];

    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);

      if (entry.isFile()) {
        const isLinuxMatch = linuxCandidates.includes(entry.name);
        const isWindowsMatch = executableName ? entry.name === executableName : false;
        if (isLinuxMatch || isWindowsMatch) {
          return fullPath;
        }
        continue;
      }

      if (!entry.isDirectory()) {
        continue;
      }

      const nestedMatch = this.findExecutableRecursively(fullPath, depth - 1);
      if (nestedMatch) {
        return nestedMatch;
      }
    }

    return undefined;
  }

  private formatBootstrapError(error: unknown) {
    const baseMessage = error instanceof Error ? error.message : String(error);

    if (!baseMessage.includes('Could not find Chrome')) {
      return baseMessage;
    }

    return (
      `${baseMessage} | Diagnostico: o backend subiu, mas o browser nao foi instalado no runtime. ` +
      'No Render em modo Node, use `npx puppeteer browsers install chrome` no Build Command; ' +
      'em modo Docker, confirme se o servico esta usando o Dockerfile e um Chrome/Chromium valido.'
    );
  }

  private sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
