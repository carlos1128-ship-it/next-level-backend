import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { create, tokenStore, Whatsapp as WppWhatsapp } from '@wppconnect-team/wppconnect';
import { IntegrationProvider } from '@prisma/client';
import * as fs from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { PrismaService } from '../../prisma/prisma.service';

type WhatsappStatus =
  | 'DISCONNECTED'
  | 'CONNECTING'
  | 'QR_READY'
  | 'AUTHENTICATING'
  | 'CONNECTED'
  | 'UNPAIRED';

type IncomingMessageShape = {
  isGroupMsg?: boolean;
  fromMe?: boolean;
  body?: string;
  from?: string;
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
  process.env.WPPCONNECT_TOKEN_DIR || path.join(process.cwd(), 'tokens');
const DEFAULT_RETRY_DELAY_MS = 20000;
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

class NeonTokenStore implements tokenStore.TokenStore {
  constructor(
    private readonly prisma: PrismaService,
    private readonly companyId: string,
    private readonly logger: Logger,
  ) {}

  async getToken() {
    try {
      const company = await this.prisma.company.findUnique({
        where: { id: this.companyId },
        select: { whatsappSessionToken: true },
      });

      if (!company?.whatsappSessionToken) {
        return undefined;
      }

      return JSON.parse(company.whatsappSessionToken) as tokenStore.SessionToken;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`[WA-TOKEN][${this.companyId}] Falha ao ler token: ${message}`);
      return undefined;
    }
  }

  async setToken(_sessionName: string, tokenData: tokenStore.SessionToken | null) {
    try {
      await this.prisma.company.update({
        where: { id: this.companyId },
        data: {
          whatsappSessionToken: tokenData ? JSON.stringify(tokenData) : null,
        },
      });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`[WA-TOKEN][${this.companyId}] Falha ao salvar token: ${message}`);
      return false;
    }
  }

  async removeToken() {
    try {
      await this.prisma.company.update({
        where: { id: this.companyId },
        data: { whatsappSessionToken: null },
      });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`[WA-TOKEN][${this.companyId}] Falha ao remover token: ${message}`);
      return false;
    }
  }

  async listTokens() {
    return [`company-${this.companyId}`];
  }
}

@Injectable()
export class WppconnectService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WppconnectService.name);
  private readonly clients = new Map<string, WppWhatsapp>();
  private readonly initializations = new Map<string, Promise<WppWhatsapp | null>>();
  private readonly qrCodes = new Map<string, string>();
  private readonly statuses = new Map<string, WhatsappStatus>();
  private readonly retryTimers = new Map<string, NodeJS.Timeout>();
  private readonly manualDisconnects = new Set<string>();

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
      this.cleanupMemory(companyId);
    }
  }

  async createSession(companyId: string, options?: { fresh?: boolean }) {
    if (options?.fresh) {
      await this.clearPersistedSessionState(companyId);
    }

    await this.ensureSessionBaseDir();
    await this.prisma.company.update({
      where: { id: companyId },
      data: {
        whatsappEnabled: true,
        whatsappStatus: 'CONNECTING',
      },
    });

    if (!options?.fresh && this.clients.has(companyId)) {
      return {
        status: this.getStatus(companyId),
        qrcode: this.getQrCode(companyId),
        qrCode: this.getQrCode(companyId),
      };
    }

    if (!this.initializations.has(companyId)) {
      this.initializations.set(companyId, this.bootstrapClient(companyId));
    }

    return {
      status: this.getStatus(companyId),
      qrcode: this.getQrCode(companyId),
      qrCode: this.getQrCode(companyId),
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

    this.cleanupMemory(companyId);
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

    const status = connected ? 'CONNECTED' : this.getStatus(companyId);

    return {
      companyId,
      status,
      connected,
      authenticated,
      connectionState,
      qrCode: this.getQrCode(companyId),
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
      needsReconnect: !connected && dbCompany?.whatsappStatus === 'CONNECTED',
      awaitingQR: !connected && status === 'QR_READY',
    };
  }

  async forceCleanupSession(companyId: string) {
    this.cancelRetry(companyId);
    const client = this.clients.get(companyId);
    if (client) {
      await client.close().catch(() => null);
    }

    this.cleanupMemory(companyId);
    await this.forceCleanupFiles(companyId);
    await this.forceCleanupTokenFiles(companyId);
    await this.prisma.company.update({
      where: { id: companyId },
      data: {
        whatsappStatus: 'DISCONNECTED',
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
        whatsappSessionToken: { not: null },
        lastConnectedAt: { gte: recentThreshold },
      },
      select: { id: true },
    });

    for (const [index, company] of companies.entries()) {
      setTimeout(() => {
        void this.createSession(company.id);
      }, index * 1000);
    }
  }

  private async bootstrapClient(companyId: string): Promise<WppWhatsapp | null> {
    const sessionName = `company-${companyId}`;
    const tokenStorage = new NeonTokenStore(this.prisma, companyId, this.logger);
    const executablePath = this.resolveBrowserExecutablePath();

    try {
      await this.forceCleanupFiles(companyId);
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
        tokenStore: tokenStorage,
        headless: this.resolveHeadless(),
        logQR: false,
        updatesLog: false,
        autoClose: 0,
        waitForLogin: false,
        disableWelcome: true,
        folderNameToken: SESSION_BASE_DIR,
        catchQR: (base64Qr) => {
          const qrCode = base64Qr.startsWith('data:')
            ? base64Qr
            : `data:image/png;base64,${base64Qr}`;
          this.qrCodes.set(companyId, qrCode);
          this.setStatus(companyId, 'QR_READY');
          void this.syncIntegrationStatus(companyId, 'awaiting_qr_scan', sessionName);
          this.eventEmitter.emit('whatsapp.qr.generated', { companyId, qrCode });
        },
        statusFind: (statusSession: string) => {
          this.handleStatusChange(companyId, statusSession, sessionName);
        },
        puppeteerOptions: {
          headless: this.resolveHeadless(),
          executablePath,
          userDataDir: this.getSessionDir(companyId),
          args: [`--user-agent=${WHATSAPP_USER_AGENT}`, ...CHROMIUM_ARGS],
        },
      });

      this.clients.set(companyId, client);
      this.initializations.delete(companyId);
      this.attachEventListeners(client, companyId, sessionName);
      return client;
    } catch (error) {
      this.initializations.delete(companyId);
      this.cleanupMemory(companyId);
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
        this.qrCodes.delete(companyId);
        this.setStatus(companyId, 'CONNECTED');
        void this.syncConnectedProfile(companyId, client, sessionName);
        return;
      }

      if (state === 'DISCONNECTED' && !this.manualDisconnects.has(companyId)) {
        this.setStatus(companyId, 'DISCONNECTED');
        void this.syncIntegrationStatus(companyId, 'disconnected', sessionName);
        this.scheduleRetry(companyId);
      }
    });

    client.onMessage((message: IncomingMessageShape) => {
      if (message.isGroupMsg || message.fromMe || !message.body || !message.from) {
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

  private handleStatusChange(companyId: string, statusSession: string, sessionName: string) {
    switch (statusSession) {
      case 'isLogged':
      case 'chatsAvailable':
      case 'qrReadSuccess':
        this.cancelRetry(companyId);
        this.qrCodes.delete(companyId);
        this.setStatus(companyId, 'CONNECTED');
        void this.syncIntegrationStatus(companyId, 'connected', sessionName);
        return;
      case 'notLogged':
        this.setStatus(companyId, 'QR_READY');
        void this.syncIntegrationStatus(companyId, 'awaiting_qr_scan', sessionName);
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
        return;
      case 'autocloseCalled':
      case 'browserClose':
      case 'phoneNotConnected':
      case 'qrReadError':
      default:
        this.setStatus(companyId, 'DISCONNECTED');
        void this.syncIntegrationStatus(companyId, 'disconnected', sessionName);
        this.scheduleRetry(companyId);
    }
  }

  private scheduleRetry(companyId: string) {
    if (this.retryTimers.has(companyId) || this.manualDisconnects.has(companyId)) {
      return;
    }

    const timer = setTimeout(() => {
      this.retryTimers.delete(companyId);
      if (!this.clients.has(companyId) && !this.initializations.has(companyId)) {
        this.initializations.set(companyId, this.bootstrapClient(companyId));
      }
    }, this.resolveRetryDelayMs());

    this.retryTimers.set(companyId, timer);
  }

  private cancelRetry(companyId: string) {
    const timer = this.retryTimers.get(companyId);
    if (!timer) return;
    clearTimeout(timer);
    this.retryTimers.delete(companyId);
  }

  private cleanupMemory(companyId: string) {
    this.clients.delete(companyId);
    this.initializations.delete(companyId);
    this.qrCodes.delete(companyId);
    this.statuses.delete(companyId);
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

  private getSessionDir(companyId: string) {
    return path.join(SESSION_BASE_DIR, `company-${companyId}`);
  }

  private getTokenDir(companyId: string) {
    return path.join(TOKEN_BASE_DIR, `company-${companyId}`);
  }

  private async forceCleanupFiles(companyId: string) {
    const sessionDir = this.getSessionDir(companyId);
    if (!fs.existsSync(sessionDir)) {
      return;
    }

    fs.rmSync(sessionDir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 1000,
    });
  }

  private async forceCleanupTokenFiles(companyId: string) {
    const tokenDir = this.getTokenDir(companyId);
    if (!fs.existsSync(tokenDir)) {
      return;
    }

    fs.rmSync(tokenDir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 1000,
    });
  }

  private async clearPersistedSessionState(companyId: string) {
    this.manualDisconnects.add(companyId);
    this.cancelRetry(companyId);

    const client = this.clients.get(companyId);
    if (client) {
      await client.logout().catch(() => null);
      await client.close().catch(() => null);
    }

    this.cleanupMemory(companyId);
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

    this.manualDisconnects.delete(companyId);
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
}
