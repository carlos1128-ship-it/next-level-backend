import {
  ConflictException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { create, Whatsapp as WppWhatsapp } from '@wppconnect-team/wppconnect';
import type { Page } from 'puppeteer';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { IntegrationProvider } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  SessionDiagnosticSnapshot,
  SessionDisposableListener,
  SessionLifecycleState,
  WhatsappStatus,
  WppSessionStateManager,
} from './wpp-session-state.manager';
import {
  computeReconnectDelay,
  shouldAttemptAutoReconnect,
} from './wppconnect.reconnect-policy';

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

type InjectionDiagnostic = {
  location: string;
  title: string;
  readyState: string;
  hasStore: boolean;
  hasWapi: boolean;
  hasWpp: boolean;
  waVersion: string | null;
  storeVersion: string | null;
  storeVersionError: string | null;
  hasQrCandidate: boolean;
  bodySnippet: string;
};

type WatchdogClient = WppWhatsapp & {
  startPhoneWatchdog?: (interval?: number) => Promise<void>;
  stopPhoneWatchdog?: (interval?: number) => Promise<void>;
  onStreamModeChanged?: (callback: (mode: string) => void) => SessionDisposableListener;
  onStreamInfoChanged?: (
    callback: (info: Record<string, unknown>) => void,
  ) => SessionDisposableListener;
};

function parseBooleanEnv(value: string | undefined, fallback: boolean) {
  if (typeof value === 'undefined') {
    return fallback;
  }

  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function parseNumberEnv(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const TEMP_ROOT_DIR = process.env.WPPCONNECT_RUNTIME_DIR || os.tmpdir();
const SESSION_BASE_DIR =
  process.env.WPPCONNECT_SESSION_DIR || path.join(TEMP_ROOT_DIR, '.wppconnect');
const TOKEN_BASE_DIR =
  process.env.WPPCONNECT_TOKEN_DIR || path.join(TEMP_ROOT_DIR, 'tokens');
const BROWSER_PROFILE_BASE_DIR =
  process.env.WPPCONNECT_BROWSER_PROFILE_DIR ||
  path.join(TEMP_ROOT_DIR, 'wpp-browser-profiles');
const QR_VALIDITY_MS = 5 * 60 * 1000;
const QR_TIMEOUT_MS = parseNumberEnv(process.env.WHATSAPP_QR_TIMEOUT_MS, 90000);
const PRE_QR_FORENSIC_HOLD_MS = parseNumberEnv(process.env.WHATSAPP_PRE_QR_HOLD_MS, 10000);
const WAPI_WAIT_TIMEOUT_MS = parseNumberEnv(process.env.WHATSAPP_WAPI_WAIT_TIMEOUT_MS, 60000);
const WHATSAPP_SKIP_RESTORE_ON_BOOT = parseBooleanEnv(
  process.env.WHATSAPP_SKIP_RESTORE_ON_BOOT,
  false,
);
const WHATSAPP_BOOT_RESTORE_DELAY_MS = parseNumberEnv(
  process.env.WHATSAPP_BOOT_RESTORE_DELAY_MS,
  1000,
);
const WPPCONNECT_AUTO_RETRY = parseBooleanEnv(process.env.WPPCONNECT_AUTO_RETRY, true);
const WPPCONNECT_RETRY_LIMIT = parseNumberEnv(process.env.WPPCONNECT_RETRY_LIMIT, 5);
const WHATSAPP_RETRY_DELAY_MS = parseNumberEnv(process.env.WHATSAPP_RETRY_DELAY_MS, 10000);
const WHATSAPP_RETRY_MAX_DELAY_MS = parseNumberEnv(
  process.env.WHATSAPP_RETRY_MAX_DELAY_MS,
  120000,
);
const WHATSAPP_PHONE_WATCHDOG_MS = parseNumberEnv(
  process.env.WHATSAPP_PHONE_WATCHDOG_MS,
  30000,
);
const WPPCONNECT_AUTO_CLOSE = Number(process.env.WPPCONNECT_AUTO_CLOSE ?? 0);
const WPPCONNECT_LOG_QR = parseBooleanEnv(
  process.env.WPPCONNECT_LOG_QR,
  process.env.NODE_ENV !== 'production',
);
const WPPCONNECT_UPDATES_LOG = parseBooleanEnv(process.env.WPPCONNECT_UPDATES_LOG, true);
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
];
const COMMON_BROWSER_PATHS = [
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];
const PUPPETEER_CACHE_ROOTS = [
  '/opt/render/.cache/puppeteer',
  '/opt/render/project/.cache/puppeteer',
  '/opt/render/project/src/.cache/puppeteer',
  path.join(process.cwd(), '.cache', 'puppeteer'),
  path.join(os.homedir(), '.cache', 'puppeteer'),
];

@Injectable()
export class WppconnectService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WppconnectService.name);
  private readonly companyLocks = new Map<string, Promise<void>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly stateManager: WppSessionStateManager,
  ) {}

  async onModuleInit() {
    if (WHATSAPP_SKIP_RESTORE_ON_BOOT) {
      this.logger.warn(
        'Restore automatico de sessoes WhatsApp desabilitado por WHATSAPP_SKIP_RESTORE_ON_BOOT.',
      );
      return;
    }

    await this.restoreActiveSessions();
  }

  async onModuleDestroy() {
    for (const companyId of this.stateManager.listCompanyIds()) {
      await this.safeDisposeRuntime(companyId, 'module_destroy', { clearMemory: true });
    }
  }

  async createSession(companyId: string, options?: { fresh?: boolean; recovery?: boolean }) {
    return this.runExclusive(companyId, async () => {
      const snapshot = this.getDiagnosticSnapshot(companyId);
      if (snapshot.cleanupInFlight) {
        throw new ConflictException({
          message: 'Cleanup da sessao em andamento. Aguarde antes de criar outra instancia.',
          companyId,
          snapshot,
        });
      }

      if (snapshot.creationInFlight && this.isTransientStartupState(snapshot.currentState)) {
        throw new ConflictException({
          message: 'Ja existe uma criacao de sessao em andamento para esta empresa.',
          companyId,
          snapshot,
        });
      }

      if (
        !options?.fresh &&
        !options?.recovery &&
        (snapshot.currentState === 'qr_ready' || snapshot.currentState === 'connected')
      ) {
        this.logLifecycle(companyId, 'log', 'create_session_reused_existing_state');
        return this.buildPublicSnapshot(companyId, 'Reutilizando estado ativo existente.');
      }

      this.clearReconnectTimer(companyId);
      if (!options?.recovery) {
        this.resetReconnectState(companyId);
      }

      if (snapshot.hasClient || snapshot.hasBrowser || snapshot.hasPage || snapshot.sessionName) {
        await this.cleanupSessionInternal(companyId, {
          reason: options?.fresh
            ? 'fresh_recreate_requested'
            : options?.recovery
              ? 'recovery_restart'
              : 'stale_runtime_before_start',
          deletePersistedState: Boolean(options?.fresh),
          clearSessionName: Boolean(options?.fresh),
          preserveReconnectState: Boolean(options?.recovery),
          resetDatabase: true,
        });
      }

      const correlationId = randomUUID();
      const sessionName = options?.fresh
        ? this.buildFreshSessionName(companyId)
        : await this.resolveSessionName(companyId);

      this.stateManager.setSessionIdentity(companyId, sessionName, correlationId);
      this.transition(companyId, 'starting', 'CONNECTING', 'instance_creation_request_received', {
        failureReason: null,
        lastError: null,
      });

      this.logLifecycle(companyId, 'log', 'instance_creation_request_received', {
        fresh: Boolean(options?.fresh),
        recovery: Boolean(options?.recovery),
      });

      const startPromise = this.bootstrapClient(companyId, sessionName, correlationId, {
        fresh: Boolean(options?.fresh),
      });
      this.stateManager.setStartPromise(companyId, startPromise);
      void startPromise.finally(() => {
        const ctx = this.stateManager.get(companyId);
        if (ctx?.sessionName === sessionName) {
          this.stateManager.setStartPromise(companyId, null);
        }
      });

      return this.buildPublicSnapshot(
        companyId,
        'Criacao da instancia iniciada. Consulte status e QR sem recriar a sessao.',
      );
    });
  }

  async terminateSession(companyId: string) {
    await this.runExclusive(companyId, async () => {
      await this.cleanupSessionInternal(companyId, {
        reason: 'manual_terminate',
        deletePersistedState: true,
        clearSessionName: true,
        resetDatabase: true,
      });
    });

    return { success: true };
  }

  async forceCleanupSession(companyId: string) {
    await this.runExclusive(companyId, async () => {
      await this.cleanupSessionInternal(companyId, {
        reason: 'forced_cleanup',
        deletePersistedState: true,
        clearSessionName: true,
        resetDatabase: true,
      });
    });

    return { success: true, companyId, status: 'DISCONNECTED' };
  }

  async clearSession(companyId: string) {
    await this.forceCleanupSession(companyId);
  }

  getStatus(companyId: string): WhatsappStatus {
    return this.stateManager.getOrCreate(companyId).status;
  }

  getQrCode(companyId: string) {
    const ctx = this.stateManager.getOrCreate(companyId);
    if (!ctx.qrCode || !ctx.qrExpiresAt) {
      return null;
    }

    if (Date.now() > ctx.qrExpiresAt) {
      this.stateManager.clearQr(companyId);
      this.transition(companyId, 'needs_new_qr', 'QR_REQUIRED', 'qr_expired', {
        failureReason: 'qr_expired',
        lastError: 'QR expirado antes da leitura.',
      });
      return null;
    }

    return ctx.qrCode;
  }

  getClient(companyId: string) {
    return this.stateManager.getOrCreate(companyId).client;
  }

  getDiagnosticSnapshot(companyId: string): SessionDiagnosticSnapshot {
    return this.stateManager.snapshot(companyId);
  }

  async sendTextMessage(companyId: string, to: string, message: string) {
    const client = this.getClient(companyId);
    if (!client) {
      throw new Error('WhatsApp nao conectado para esta empresa.');
    }

    await client.sendText(this.normalizeRecipient(to), message);
    return { sent: true };
  }

  async getHealthStatus(companyId: string) {
    const snapshot = this.getDiagnosticSnapshot(companyId);
    const client = this.getClient(companyId);
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
    let connectionState: string | null = snapshot.lastKnownConnectionState;
    let phoneNumber: string | null = null;
    let pushname: string | null = null;
    let runtimeError: string | null = null;
    let waVersion: string | null = null;

    if (client) {
      try {
        const [clientConnected, isAuthenticated, state, host, currentWaVersion] = await Promise.all([
          client.isConnected(),
          client.isAuthenticated(),
          client.getConnectionState(),
          client.getHostDevice(),
          client.getWAVersion().catch(() => null),
        ]);
        authenticated = isAuthenticated;
        connectionState = state ? String(state) : null;
        connected = Boolean(clientConnected && isAuthenticated);
        waVersion = currentWaVersion ? String(currentWaVersion) : null;
        phoneNumber = this.extractPhoneNumber(host as HostDeviceShape | undefined);
        pushname = this.extractDisplayName(host as HostDeviceShape | undefined, phoneNumber);
      } catch (error) {
        runtimeError = error instanceof Error ? error.message : String(error);
      }
    }

    const qrCode = this.getQrCode(companyId);
    const currentSnapshot = this.getDiagnosticSnapshot(companyId);

    return {
      companyId,
      status: currentSnapshot.status,
      lifecycleState: currentSnapshot.currentState,
      connected,
      authenticated,
      connectionState,
      qrCode,
      phoneNumber,
      pushname,
      hasClient: currentSnapshot.hasClient,
      hasBrowser: currentSnapshot.hasBrowser,
      hasPage: currentSnapshot.hasPage,
      creationInFlight: currentSnapshot.creationInFlight,
      cleanupInFlight: currentSnapshot.cleanupInFlight,
      lastError: runtimeError || currentSnapshot.lastError,
      failureReason: currentSnapshot.failureReason,
      versionWarning: currentSnapshot.versionWarning,
      waVersion,
      dbStatus: dbCompany?.whatsappStatus || 'DISCONNECTED',
      dbEnabled: Boolean(dbCompany?.whatsappEnabled),
      dbLastConnected: dbCompany?.lastConnectedAt?.toISOString() || null,
      healthy: connected,
      awaitingQR: currentSnapshot.currentState === 'qr_ready',
      qrRequired: currentSnapshot.currentState === 'needs_new_qr',
      hasInitialization: currentSnapshot.creationInFlight,
      hasRetryTimer: currentSnapshot.hasReconnectTimer,
      reconnectAttempts: currentSnapshot.reconnectAttempts,
      nextReconnectAt: currentSnapshot.nextReconnectAt,
      needsReconnect:
        !connected &&
        (currentSnapshot.hasReconnectTimer ||
          currentSnapshot.currentState === 'failed' ||
          currentSnapshot.currentState === 'disconnected'),
      diagnosticSnapshot: currentSnapshot,
      machineState: currentSnapshot.currentState,
    };
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
      const sessionName = company.whatsappSessionName || this.buildCompanySessionPrefix(company.id);
      if (!this.hasPersistedSessionData(company.id, sessionName)) {
        this.logLifecycle(company.id, 'warn', 'restore_skipped_missing_local_tokens', {
          sessionName,
        });
        continue;
      }

      setTimeout(() => {
        void this.createSession(company.id, { recovery: true }).catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          this.logLifecycle(company.id, 'warn', 'restore_failed', { error: message });
        });
      }, index * WHATSAPP_BOOT_RESTORE_DELAY_MS);
    }
  }

  private async bootstrapClient(
    companyId: string,
    sessionName: string,
    correlationId: string,
    options: { fresh: boolean },
  ): Promise<WppWhatsapp | null> {
    const executablePath = this.resolveBrowserExecutablePath();
    const userDataDir = this.buildStableUserDataDir(companyId);

    try {
      if (options.fresh) {
        await this.clearPersistedSessionState(companyId, sessionName, correlationId);
      }
      await this.ensureRuntimeDirectories(companyId);

      await this.prisma.company.update({
        where: { id: companyId },
        data: {
          whatsappEnabled: true,
          whatsappStatus: 'CONNECTING',
          whatsappSessionName: sessionName,
        },
      }).catch(() => null);

      this.transition(companyId, 'starting', 'CONNECTING', 'browser_launch_start');
      this.logLifecycle(companyId, 'log', 'browser_launch_start', {
        executablePath: executablePath || null,
        headless: this.resolveHeadless(),
        userDataDir,
        userAgent: WHATSAPP_USER_AGENT,
      });

      this.logLifecycle(companyId, 'log', 'wapi_injection_wait_start');

      const client = await create({
        session: sessionName,
        tokenStore: 'file',
        headless: this.resolveHeadless(),
        devtools: false,
        useChrome: false,
        debug: false,
        logQR: WPPCONNECT_LOG_QR,
        updatesLog: WPPCONNECT_UPDATES_LOG,
        browserWS: '',
        browserArgs: CHROMIUM_ARGS,
        autoClose: WPPCONNECT_AUTO_CLOSE > 0 ? WPPCONNECT_AUTO_CLOSE : 0,
        waitForLogin: false,
        disableWelcome: true,
        folderNameToken: TOKEN_BASE_DIR,
        mkdirFolderToken: TOKEN_BASE_DIR,
        createPathFileToken: true,
        // O WPPConnect 1.41.2 injeta uma versao fixa por default.
        // Precisamos sobrescrever com undefined para nao quebrar a injecao.
        whatsappVersion: undefined,
        catchQR: (base64Qr, asciiQr, attempts) => {
          this.logLifecycle(companyId, 'log', 'qr_received_from_wppconnect', {
            attempts: attempts ?? 1,
          });
          this.handleQrCallback(
            companyId,
            sessionName,
            correlationId,
            base64Qr,
            asciiQr,
            attempts ?? 1,
          );
        },
        statusFind: (statusSession: string) => {
          void this.handleStatusChange(companyId, sessionName, correlationId, statusSession);
        },
        puppeteerOptions: {
          headless: this.resolveHeadless(),
          protocolTimeout: 120000,
          args: CHROMIUM_ARGS,
          ignoreDefaultArgs: ['--enable-automation'],
          executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || executablePath || undefined,
          userDataDir,
        },
      });

      if (!this.isCurrentSession(companyId, sessionName)) {
        await client.close().catch(() => null);
        return null;
      }

      this.stateManager.setClient(companyId, client);
      this.attachPageDiagnostics(client, companyId, sessionName, correlationId);
      this.transition(companyId, 'browser_ready', 'CONNECTING', 'browser_launch_complete');
      this.logLifecycle(companyId, 'log', 'browser_launch_complete', {
        pageReady: Boolean((client as unknown as { page?: unknown }).page),
      });

      this.transition(companyId, 'whatsapp_loading', 'AUTHENTICATING', 'page_ready');
      this.logLifecycle(companyId, 'log', 'page_ready');
      await this.probePage(companyId, sessionName, 'post_create_page_probe');
      await this.verifyWapiInjection(companyId, sessionName);

      this.attachEventListeners(client, companyId, sessionName, correlationId);
      this.startQrTimeout(companyId, sessionName, correlationId);
      await this.startPhoneWatchdog(companyId, client, sessionName);
      return client;
    } catch (error) {
      const message = this.formatBootstrapError(error);
      this.transition(companyId, 'failed', 'DISCONNECTED', 'bootstrap_failed', {
        lastError: message,
        failureReason: 'bootstrap_failed',
      });
      this.logLifecycle(companyId, 'error', 'bootstrap_failed', { error: message });
      await this.safeDisposeRuntime(companyId, 'bootstrap_failed', {
        clearMemory: false,
        preserveQr: true,
      });
      return null;
    }
  }

  private attachEventListeners(
    client: WppWhatsapp,
    companyId: string,
    sessionName: string,
    correlationId: string,
  ) {
    const runtimeClient = client as WatchdogClient;
    const listeners: SessionDisposableListener[] = [];

    listeners.push(
      client.onStateChange((state: string) => {
        void this.handleStateChange(companyId, sessionName, correlationId, state);
      }),
    );

    listeners.push(
      client.onMessage((message: IncomingMessageShape) => {
        if (
          !this.isCurrentSession(companyId, sessionName) ||
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
      }),
    );

    if (runtimeClient.onStreamModeChanged) {
      listeners.push(
        runtimeClient.onStreamModeChanged((mode: string) => {
          if (!this.isCurrentSession(companyId, sessionName)) {
            return;
          }

          this.logLifecycle(companyId, 'log', 'stream_mode_changed', { mode });
        }),
      );
    }

    if (runtimeClient.onStreamInfoChanged) {
      listeners.push(
        runtimeClient.onStreamInfoChanged((info: Record<string, unknown>) => {
          if (!this.isCurrentSession(companyId, sessionName)) {
            return;
          }

          let serializedInfo = '[unserializable]';
          try {
            serializedInfo = JSON.stringify(info).slice(0, 400);
          } catch {
            serializedInfo = '[unserializable]';
          }

          this.logLifecycle(companyId, 'log', 'stream_info_changed', {
            info: serializedInfo,
          });
        }),
      );
    }

    this.stateManager.setListeners(companyId, listeners);
  }

  private attachPageDiagnostics(
    client: WppWhatsapp,
    companyId: string,
    sessionName: string,
    correlationId: string,
  ) {
    const page = this.extractPage(client);
    if (!page) {
      this.logLifecycle(companyId, 'warn', 'page_diagnostics_unavailable', {
        sessionName,
        correlationId,
      });
      return;
    }

    page.on('console', (message) => {
      if (!this.isCurrentSession(companyId, sessionName)) {
        return;
      }

      this.logLifecycle(companyId, 'log', 'page_console', {
        type: message.type(),
        text: message.text().slice(0, 300),
      });
    });

    page.on('pageerror', (error: unknown) => {
      if (!this.isCurrentSession(companyId, sessionName)) {
        return;
      }

      this.logLifecycle(companyId, 'error', 'page_error', {
        error: error instanceof Error ? error.message : String(error),
      });
    });

    page.on('requestfailed', (request) => {
      if (!this.isCurrentSession(companyId, sessionName)) {
        return;
      }

      this.logLifecycle(companyId, 'warn', 'page_request_failed', {
        url: request.url(),
        method: request.method(),
        failure: request.failure()?.errorText || null,
      });
    });

    page.on('close', () => {
      if (!this.isCurrentSession(companyId, sessionName)) {
        return;
      }

      this.logLifecycle(companyId, 'warn', 'page_close_detected', {
        sessionName,
        correlationId,
      });

      const currentState = this.stateManager.getOrCreate(companyId).lifecycleState;
      if (currentState === 'cleaning_up' || currentState === 'needs_new_qr') {
        return;
      }

      void this.markFailed(companyId, sessionName, 'page_closed', 'page_close_detected');
    });
  }

  private async handleStateChange(
    companyId: string,
    sessionName: string,
    correlationId: string,
    state: string,
  ) {
    if (!this.isCurrentSession(companyId, sessionName)) {
      this.logLifecycle(companyId, 'warn', 'state_change_ignored_old_session', {
        state,
        sessionName,
        correlationId,
      });
      return;
    }

    this.logLifecycle(companyId, 'log', 'connection_state_changed', { state });

    if (state === 'CONNECTED') {
      this.clearReconnectTimer(companyId);
      this.resetReconnectState(companyId);
      this.transition(companyId, 'connected', 'CONNECTED', 'connected_state_change', {
        lastKnownConnectionState: state,
        lastError: null,
        failureReason: null,
      });
      this.stateManager.clearQr(companyId);
      this.clearQrTimeout(companyId);
      await this.syncConnectedProfile(companyId, sessionName);
      return;
    }

    if (state === 'DISCONNECTED') {
      const currentState = this.stateManager.getOrCreate(companyId).lifecycleState;
      if (currentState === 'needs_new_qr' || currentState === 'cleaning_up') {
        this.logLifecycle(companyId, 'warn', 'disconnect_after_terminal_state_ignored', { state });
        await this.safeDisposeRuntime(companyId, 'disconnect_after_terminal_state', {
          clearMemory: false,
          preserveQr: true,
        });
        return;
      }

      await this.markFailed(companyId, sessionName, 'DISCONNECTED', 'state_change_disconnected');
    }
  }

  private async handleStatusChange(
    companyId: string,
    sessionName: string,
    correlationId: string,
    statusSession: string,
  ) {
    if (!this.isCurrentSession(companyId, sessionName)) {
      this.logLifecycle(companyId, 'warn', 'status_event_ignored_old_session', {
        statusSession,
        sessionName,
        correlationId,
      });
      return;
    }

    this.eventEmitter.emit('whatsapp.status.updated', {
      companyId,
      status: statusSession,
    });
    this.logLifecycle(companyId, 'log', 'status_event_received', { rawStatus: statusSession });
    await this.probePage(companyId, sessionName, `status_probe_${statusSession}`);

    switch (statusSession) {
      case 'openBrowser':
        this.transition(companyId, 'starting', 'CONNECTING', 'status_open_browser');
        return;
      case 'connectBrowserWs':
      case 'initWhatsapp':
        this.transition(companyId, 'browser_ready', 'CONNECTING', `status_${statusSession}`);
        return;
      case 'waitChat':
      case 'connecting':
      case 'notLogged':
        this.transition(companyId, 'whatsapp_loading', 'AUTHENTICATING', `status_${statusSession}`);
        return;
      case 'qrReadSuccess':
        this.transition(companyId, 'pairing', 'AUTHENTICATING', 'status_qr_read_success');
        return;
      case 'isLogged':
      case 'inChat':
      case 'chatsAvailable':
        this.clearReconnectTimer(companyId);
        this.resetReconnectState(companyId);
        this.transition(companyId, 'connected', 'CONNECTED', `status_${statusSession}`, {
          lastError: null,
          failureReason: null,
        });
        this.stateManager.clearQr(companyId);
        this.clearQrTimeout(companyId);
        await this.syncConnectedProfile(companyId, sessionName);
        return;
      case 'sessionUnpaired':
      case 'deleteToken':
      case 'desconnectedMobile':
      case 'disconnectedMobile':
      case 'qrReadError':
      case 'qrReadFail':
        await this.markNeedsNewQr(companyId, sessionName, statusSession);
        return;
      case 'browserClose':
      case 'serverClose':
      case 'autocloseCalled': {
        const currentState = this.stateManager.getOrCreate(companyId).lifecycleState;
        if (currentState === 'needs_new_qr' || currentState === 'cleaning_up') {
          this.logLifecycle(companyId, 'warn', 'browser_close_after_terminal_state', {
            rawStatus: statusSession,
          });
          await this.safeDisposeRuntime(companyId, 'browser_close_after_terminal_state', {
            clearMemory: false,
            preserveQr: true,
          });
          return;
        }

        await this.markFailed(companyId, sessionName, statusSession, 'browser_or_server_closed');
        return;
      }
      case 'phoneNotConnected':
      default:
        await this.markFailed(companyId, sessionName, statusSession, 'unexpected_status_event');
    }
  }

  private handleQrCallback(
    companyId: string,
    sessionName: string,
    correlationId: string,
    base64Qr: string,
    _asciiQr: string,
    attempts: number,
  ) {
    if (!this.isCurrentSession(companyId, sessionName)) {
      this.logLifecycle(companyId, 'warn', 'qr_callback_ignored_old_session', {
        attempts,
        sessionName,
        correlationId,
      });
      return;
    }

    const now = Date.now();
    const qrCode = base64Qr.startsWith('data:') ? base64Qr : `data:image/png;base64,${base64Qr}`;
    this.stateManager.setQr(companyId, qrCode, now, now + QR_VALIDITY_MS);
    this.transition(companyId, 'qr_ready', 'QR_READY', 'qr_callback_received', {
      lastError: null,
      failureReason: null,
    });
    this.logLifecycle(companyId, 'log', 'qr_callback_received', {
      attempts,
      generatedAt: new Date(now).toISOString(),
    });
    this.logLifecycle(companyId, 'log', 'qr_persisted_in_memory', { attempts });

    this.eventEmitter.emit('whatsapp.qr.generated', {
      companyId,
      qrCode,
      attempts,
      sessionName,
    });
    this.logLifecycle(companyId, 'log', 'qr_emitted_through_socket', { attempts });
    void this.syncIntegrationStatus(companyId, 'awaiting_qr_scan', sessionName);
  }

  private async markNeedsNewQr(companyId: string, sessionName: string, rawStatus: string) {
    this.clearReconnectTimer(companyId);
    this.transition(companyId, 'needs_new_qr', 'QR_REQUIRED', 'terminal_needs_new_qr', {
      failureReason: rawStatus,
      lastError: rawStatus,
      lastKnownConnectionState: rawStatus,
    });
    this.logLifecycle(companyId, 'warn', 'terminal_needs_new_qr', {
      rawStatus,
      qrAvailable: Boolean(this.getQrCode(companyId)),
    });
    await this.probePage(companyId, sessionName, 'pre_qr_terminal_probe');
    this.clearQrTimeout(companyId);

    await this.prisma.company.update({
      where: { id: companyId },
      data: {
        whatsappStatus: 'QR_REQUIRED',
        whatsappEnabled: false,
        whatsappSessionName: sessionName,
        whatsappSessionToken: null,
        whatsappWid: null,
        whatsappName: null,
        whatsappAvatar: null,
      },
    }).catch(() => null);
    await this.syncIntegrationStatus(companyId, 'awaiting_qr_scan', sessionName);

    this.eventEmitter.emit('whatsapp.status.updated', {
      companyId,
      status: 'needs_new_qr',
    });

    this.logLifecycle(companyId, 'warn', 'terminal_state_cleanup_delayed_for_qr', {
      rawStatus,
      forensicHoldMs: PRE_QR_FORENSIC_HOLD_MS,
      qrAvailableNow: Boolean(this.getQrCode(companyId)),
    });

    await this.sleep(PRE_QR_FORENSIC_HOLD_MS);
    if (!this.isCurrentSession(companyId, sessionName)) {
      return;
    }

    await this.probePage(companyId, sessionName, 'post_terminal_grace_probe');
    if (this.getQrCode(companyId)) {
      this.logLifecycle(companyId, 'log', 'terminal_state_cleanup_skipped_qr_available', {
        rawStatus,
      });
      return;
    }

    this.logger.error('QR NEVER GENERATED');
    this.logLifecycle(companyId, 'error', 'qr_callback_never_fired_before_terminal_state', {
      rawStatus,
      forensicHoldMs: PRE_QR_FORENSIC_HOLD_MS,
    });

    await this.safeDisposeRuntime(companyId, 'post_forensic_pre_qr_cleanup', {
      clearMemory: false,
      preserveQr: true,
    });
  }

  private async markFailed(
    companyId: string,
    sessionName: string,
    rawStatus: string,
    event: string,
  ) {
    this.transition(companyId, 'failed', 'DISCONNECTED', event, {
      failureReason: rawStatus,
      lastError: rawStatus,
      lastKnownConnectionState: rawStatus,
    });
    this.logLifecycle(companyId, 'error', event, { rawStatus });
    this.clearQrTimeout(companyId);

    await this.prisma.company.update({
      where: { id: companyId },
      data: {
        whatsappStatus: 'DISCONNECTED',
        whatsappEnabled: false,
      },
    }).catch(() => null);
    await this.syncIntegrationStatus(companyId, 'disconnected', sessionName);
    await this.safeDisposeRuntime(companyId, event, {
      clearMemory: false,
      preserveQr: true,
    });

    const scheduled = await this.scheduleReconnect(companyId, sessionName, rawStatus);
    if (!scheduled) {
      this.clearReconnectTimer(companyId);
    }
  }

  private async cleanupSessionInternal(
    companyId: string,
    options: {
      reason: string;
      deletePersistedState: boolean;
      clearSessionName: boolean;
      preserveReconnectState?: boolean;
      resetDatabase: boolean;
    },
  ) {
    const existingCleanup = this.stateManager.getOrCreate(companyId).cleanupPromise;
    if (existingCleanup) {
      await existingCleanup;
      return;
    }

    const ctx = this.stateManager.getOrCreate(companyId);
    const cleanupPromise = (async () => {
      this.transition(companyId, 'cleaning_up', 'DISCONNECTED', 'cleanup_start', {
        lastError: ctx.lastError,
        failureReason: ctx.failureReason,
      });
      this.logLifecycle(companyId, 'log', 'cleanup_start', options);
      this.clearQrTimeout(companyId);
      this.clearReconnectTimer(companyId);
      if (!options.preserveReconnectState) {
        this.resetReconnectState(companyId);
      }

      await this.safeDisposeRuntime(companyId, options.reason, {
        clearMemory: false,
        preserveQr: false,
      });

      if (options.deletePersistedState) {
        await this.forceCleanupFiles(companyId, ctx.sessionName || undefined);
        await this.forceCleanupTokenFiles(companyId, ctx.sessionName || undefined);
        await this.forceCleanupBrowserProfile(companyId);
      }

      if (options.resetDatabase) {
        await this.prisma.company.update({
          where: { id: companyId },
          data: {
            whatsappStatus: 'DISCONNECTED',
            whatsappEnabled: false,
            whatsappSessionName: options.clearSessionName ? null : ctx.sessionName,
            whatsappSessionToken: null,
            whatsappWid: null,
            whatsappName: null,
            whatsappAvatar: null,
          },
        }).catch(() => null);
        await this.syncIntegrationStatus(companyId, 'disconnected');
      }

      this.stateManager.clearQr(companyId);
      this.transition(companyId, 'disconnected', 'DISCONNECTED', 'cleanup_complete', {
        failureReason: null,
        lastError: null,
      });

      if (options.clearSessionName) {
        this.stateManager.clear(companyId);
      } else {
        this.stateManager.setClient(companyId, null);
      }

      this.logLifecycle(companyId, 'log', 'cleanup_complete', {
        clearSessionName: options.clearSessionName,
      });
    })();

    this.stateManager.setCleanupPromise(companyId, cleanupPromise);
    try {
      await cleanupPromise;
    } finally {
      const current = this.stateManager.get(companyId);
      if (current) {
        this.stateManager.setCleanupPromise(companyId, null);
      }
    }
  }

  private async clearPersistedSessionState(
    companyId: string,
    sessionName: string,
    correlationId: string,
  ) {
    this.logLifecycle(companyId, 'log', 'token_cleanup_start', {
      sessionName,
      correlationId,
    });
    await this.ensureSessionBaseDir();
    await this.forceCleanupFiles(companyId, sessionName);
    await this.forceCleanupTokenFiles(companyId, sessionName);
    this.logLifecycle(companyId, 'log', 'token_cleanup_end', {
      sessionName,
      correlationId,
    });
  }

  private startQrTimeout(companyId: string, sessionName: string, correlationId: string) {
    this.clearQrTimeout(companyId);
    const timer = setTimeout(() => {
      if (!this.isCurrentSession(companyId, sessionName)) {
        return;
      }

      const state = this.stateManager.getOrCreate(companyId).lifecycleState;
      if (state === 'qr_ready' || state === 'connected' || state === 'needs_new_qr') {
        return;
      }

      this.transition(companyId, 'failed', 'DISCONNECTED', 'qr_timeout_reached', {
        lastError: 'QR nao foi produzido dentro da janela esperada.',
        failureReason: 'qr_timeout',
      });
      this.logger.error('QR NEVER GENERATED');
      this.logLifecycle(companyId, 'error', 'qr_timeout_reached', {
        sessionName,
        correlationId,
      });
      void this.safeDisposeRuntime(companyId, 'qr_timeout_reached', {
        clearMemory: false,
        preserveQr: true,
      });
      void this.scheduleReconnect(companyId, sessionName, 'qr_timeout');
    }, QR_TIMEOUT_MS);

    this.stateManager.setQrTimeoutTimer(companyId, timer);
  }

  private clearQrTimeout(companyId: string) {
    const ctx = this.stateManager.get(companyId);
    if (!ctx?.qrTimeoutTimer) {
      return;
    }

    clearTimeout(ctx.qrTimeoutTimer);
    this.stateManager.setQrTimeoutTimer(companyId, null);
  }

  private clearReconnectTimer(companyId: string) {
    const ctx = this.stateManager.get(companyId);
    if (!ctx?.reconnectTimer) {
      return;
    }

    clearTimeout(ctx.reconnectTimer);
    this.stateManager.setReconnectTimer(companyId, null);
    this.stateManager.setReconnectState(companyId, {
      nextReconnectAt: null,
    });
  }

  private resetReconnectState(companyId: string) {
    this.stateManager.setReconnectState(companyId, {
      reconnectAttempts: 0,
      nextReconnectAt: null,
      lastReconnectAt: null,
    });
  }

  private async startPhoneWatchdog(
    companyId: string,
    client: WppWhatsapp,
    sessionName: string,
  ) {
    const runtimeClient = client as WatchdogClient;
    if (!runtimeClient.startPhoneWatchdog || !this.isCurrentSession(companyId, sessionName)) {
      return;
    }

    try {
      await runtimeClient.startPhoneWatchdog(WHATSAPP_PHONE_WATCHDOG_MS);
      this.logLifecycle(companyId, 'log', 'phone_watchdog_started', {
        intervalMs: WHATSAPP_PHONE_WATCHDOG_MS,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logLifecycle(companyId, 'warn', 'phone_watchdog_start_failed', { error: message });
    }
  }

  private async scheduleReconnect(
    companyId: string,
    sessionName: string,
    reason: string,
  ) {
    if (!WPPCONNECT_AUTO_RETRY || !shouldAttemptAutoReconnect(reason)) {
      return false;
    }

    const ctx = this.stateManager.getOrCreate(companyId);
    if (ctx.cleanupPromise || ctx.reconnectTimer || !this.isCurrentSession(companyId, sessionName)) {
      return false;
    }

    const nextAttempt = ctx.reconnectAttempts + 1;
    if (nextAttempt > WPPCONNECT_RETRY_LIMIT) {
      this.logLifecycle(companyId, 'error', 'reconnect_limit_reached', {
        reason,
        attempt: nextAttempt,
        limit: WPPCONNECT_RETRY_LIMIT,
      });
      return false;
    }

    const delayMs = computeReconnectDelay(
      nextAttempt,
      WHATSAPP_RETRY_DELAY_MS,
      WHATSAPP_RETRY_MAX_DELAY_MS,
    );
    const scheduledAt = Date.now() + delayMs;

    const timer = setTimeout(() => {
      this.stateManager.setReconnectTimer(companyId, null);
      this.stateManager.setReconnectState(companyId, {
        reconnectAttempts: nextAttempt,
        nextReconnectAt: null,
        lastReconnectAt: Date.now(),
      });

      void this.createSession(companyId, { recovery: true }).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.logLifecycle(companyId, 'warn', 'reconnect_attempt_failed', {
          reason,
          attempt: nextAttempt,
          error: message,
        });
      });
    }, delayMs);

    this.stateManager.setReconnectTimer(companyId, timer);
    this.stateManager.setReconnectState(companyId, {
      reconnectAttempts: nextAttempt,
      nextReconnectAt: scheduledAt,
    });

    this.eventEmitter.emit('whatsapp.status.updated', {
      companyId,
      status: 'reconnecting',
    });
    await this.syncIntegrationStatus(companyId, 'reconnecting', sessionName);
    this.logLifecycle(companyId, 'warn', 'reconnect_scheduled', {
      reason,
      attempt: nextAttempt,
      delayMs,
      scheduledAt: new Date(scheduledAt).toISOString(),
    });

    return true;
  }

  private async safeDisposeRuntime(
    companyId: string,
    reason: string,
    options?: {
      clearMemory?: boolean;
      preserveQr?: boolean;
    },
  ) {
    const ctx = this.stateManager.get(companyId);
    if (ctx) {
      this.stateManager.clearListeners(companyId);
    }

    if (!ctx?.client) {
      if (options?.clearMemory) {
        this.stateManager.clear(companyId);
      }
      return;
    }

    const runtimeClient = ctx.client as WatchdogClient;
    if (runtimeClient.stopPhoneWatchdog) {
      await runtimeClient.stopPhoneWatchdog(WHATSAPP_PHONE_WATCHDOG_MS).catch(() => null);
    }

    this.logLifecycle(companyId, 'log', 'client_destroy_start', { reason });
    await ctx.client.close().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      this.logLifecycle(companyId, 'warn', 'client_destroy_error', { reason, error: message });
    });
    this.logLifecycle(companyId, 'log', 'client_destroy_end', { reason });

    this.stateManager.setClient(companyId, null);
    this.stateManager.setStartPromise(companyId, null);

    if (!options?.preserveQr) {
      this.stateManager.clearQr(companyId);
    }

    if (options?.clearMemory) {
      this.stateManager.clear(companyId);
    }
  }

  private async syncConnectedProfile(companyId: string, sessionName: string) {
    const client = this.getClient(companyId);
    if (!client) {
      return;
    }

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
      this.logLifecycle(companyId, 'log', 'connected_profile_synced', {
        phoneNumber,
        displayName,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logLifecycle(companyId, 'warn', 'connected_profile_sync_failed', { error: message });
    }
  }

  private buildPublicSnapshot(companyId: string, message: string) {
    const diagnosticSnapshot = this.getDiagnosticSnapshot(companyId);
    const qrCode = this.getQrCode(companyId);

    return {
      companyId,
      instanceName: diagnosticSnapshot.sessionName,
      qrcode: qrCode,
      qrCode,
      ready: Boolean(qrCode),
      status: diagnosticSnapshot.status,
      lifecycleState: diagnosticSnapshot.currentState,
      failureReason: diagnosticSnapshot.failureReason,
      connected: diagnosticSnapshot.currentState === 'connected',
      message,
      diagnosticSnapshot,
    };
  }

  private transition(
    companyId: string,
    lifecycleState: SessionLifecycleState,
    status: WhatsappStatus,
    event: string,
    details?: {
      lastError?: string | null;
      failureReason?: string | null;
      lastKnownConnectionState?: string | null;
      versionWarning?: string | null;
    },
  ) {
    this.stateManager.transition(companyId, lifecycleState, status, event, details);
  }

  private isTransientStartupState(state: SessionLifecycleState) {
    return (
      state === 'starting' ||
      state === 'browser_ready' ||
      state === 'whatsapp_loading' ||
      state === 'pairing'
    );
  }

  private async runExclusive<T>(companyId: string, action: () => Promise<T>) {
    const previous = this.companyLocks.get(companyId) || Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });

    this.companyLocks.set(companyId, previous.catch(() => undefined).then(() => current));
    await previous.catch(() => undefined);

    try {
      return await action();
    } finally {
      release();
      if (this.companyLocks.get(companyId) === current) {
        this.companyLocks.delete(companyId);
      }
    }
  }

  private isCurrentSession(companyId: string, sessionName: string) {
    return this.stateManager.getOrCreate(companyId).sessionName === sessionName;
  }

  private buildCompanySessionPrefix(companyId: string) {
    return `company-${companyId}`;
  }

  private buildFreshSessionName(companyId: string) {
    return `${this.buildCompanySessionPrefix(companyId)}-${Date.now()}`;
  }

  private async resolveSessionName(companyId: string) {
    const cached = this.stateManager.get(companyId)?.sessionName;
    if (cached) {
      return cached;
    }

    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { whatsappSessionName: true },
    });

    return company?.whatsappSessionName || this.buildCompanySessionPrefix(companyId);
  }

  private normalizeRecipient(value: string) {
    const trimmed = value.trim();
    if (trimmed.includes('@')) {
      return trimmed;
    }

    const digits = trimmed.replace(/\D/g, '');
    if (!digits) {
      throw new Error('Numero de destino invalido para envio via WhatsApp.');
    }

    return `${digits}@c.us`;
  }

  private resolveHeadless(): boolean | 'shell' {
    const rawValue = process.env.WPPCONNECT_HEADLESS?.trim().toLowerCase();
    if (rawValue === 'shell') {
      return 'shell';
    }

    if (typeof rawValue !== 'undefined') {
      return ['1', 'true', 'yes', 'on'].includes(rawValue);
    }

    return process.env.NODE_ENV === 'production';
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

  private async syncIntegrationStatus(companyId: string, status: string, externalId?: string) {
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

  private async ensureSessionBaseDir() {
    await mkdir(SESSION_BASE_DIR, { recursive: true }).catch(() => null);
  }

  private async ensureRuntimeDirectories(companyId: string) {
    await this.ensureSessionBaseDir();
    await mkdir(TOKEN_BASE_DIR, { recursive: true }).catch(() => null);
    await mkdir(BROWSER_PROFILE_BASE_DIR, { recursive: true }).catch(() => null);
    await mkdir(this.buildStableUserDataDir(companyId), { recursive: true }).catch(() => null);
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

  private async forceCleanupBrowserProfile(companyId: string) {
    this.removeDirectories(companyId, [this.buildStableUserDataDir(companyId)], 'browser_profile');
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
    return entryName === companyId || entryName === prefix || entryName.startsWith(`${prefix}-`);
  }

  private removeDirectories(companyId: string, directories: string[], label: string) {
    const uniqueDirectories = [...new Set(directories)];

    for (const currentPath of uniqueDirectories) {
      try {
        if (!fs.existsSync(currentPath)) {
          continue;
        }

        this.logLifecycle(companyId, 'warn', 'filesystem_cleanup_path', {
          label,
          path: currentPath,
        });
        fs.rmSync(currentPath, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 500,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logLifecycle(companyId, 'warn', 'filesystem_cleanup_failed', {
          label,
          path: currentPath,
          error: message,
        });
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

    const executableName = process.platform === 'win32' ? 'chrome.exe' : undefined;
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
      'No Render em modo Node, use `npx puppeteer browsers install chrome` no Build Command.'
    );
  }

  private logLifecycle(
    companyId: string,
    level: 'log' | 'warn' | 'error',
    event: string,
    extra?: Record<string, unknown>,
  ) {
    const snapshot = this.getDiagnosticSnapshot(companyId);
    const payload = {
      timestamp: new Date().toISOString(),
      companyId,
      sessionName: snapshot.sessionName,
      correlationId: snapshot.correlationId,
      currentState: snapshot.currentState,
      event,
      ...extra,
    };

    this.logger[level](JSON.stringify(payload));
  }

  private extractPage(client: WppWhatsapp) {
    return (client as unknown as { page?: Page }).page || null;
  }

  private async verifyWapiInjection(companyId: string, sessionName: string) {
    const client = this.getClient(companyId);
    const page = client ? this.extractPage(client) : null;
    if (!page || !this.isCurrentSession(companyId, sessionName)) {
      throw new Error('Pagina do WhatsApp indisponivel durante a validacao da injecao.');
    }

    const initialProbe = await this.probePage(companyId, sessionName, 'wapi_wait_start_probe');

    try {
      await page.waitForFunction(
        () => {
          const runtimeWindow = window as typeof window & {
            WAPI?: unknown;
            Store?: unknown;
          };

          return runtimeWindow.WAPI !== undefined || runtimeWindow.Store !== undefined;
        },
        { timeout: WAPI_WAIT_TIMEOUT_MS },
      );
    } catch (error) {
      const timeoutProbe = await this.probePage(companyId, sessionName, 'wapi_wait_timeout_probe');
      const message = error instanceof Error ? error.message : String(error);
      const fatalMessage = `WAPI/Store nao ficaram disponiveis apos ${WAPI_WAIT_TIMEOUT_MS}ms.`;
      this.transition(
        companyId,
        this.stateManager.getOrCreate(companyId).lifecycleState,
        this.getStatus(companyId),
        'wapi_injection_fatal',
        {
          lastError: fatalMessage,
          failureReason: 'wapi_injection_failed',
        },
      );
      this.logLifecycle(companyId, 'error', 'wapi_injection_fatal', {
        error: message,
        timeoutMs: WAPI_WAIT_TIMEOUT_MS,
        initialProbe,
        timeoutProbe,
      });
      throw new Error(`${fatalMessage} Detalhe: ${message}`);
    }

    const finalProbe = await this.probePage(companyId, sessionName, 'post_wapi_injection_probe');
    if (!finalProbe?.hasWapi) {
      const fatalMessage = `WAPI continuou indefinido apos ${WAPI_WAIT_TIMEOUT_MS}ms.`;
      this.transition(
        companyId,
        this.stateManager.getOrCreate(companyId).lifecycleState,
        this.getStatus(companyId),
        'wapi_injection_fatal',
        {
          lastError: fatalMessage,
          failureReason: 'wapi_injection_failed',
        },
      );
      this.logLifecycle(companyId, 'error', 'wapi_injection_fatal', {
        timeoutMs: WAPI_WAIT_TIMEOUT_MS,
        finalProbe,
      });
      throw new Error(fatalMessage);
    }

    this.logLifecycle(companyId, 'log', 'wapi_injection_complete', {
      timeoutMs: WAPI_WAIT_TIMEOUT_MS,
      finalProbe,
    });
  }

  private async probePage(
    companyId: string,
    sessionName: string,
    event: string,
  ): Promise<InjectionDiagnostic | null> {
    const client = this.getClient(companyId);
    const page = client ? this.extractPage(client) : null;
    if (!page || !this.isCurrentSession(companyId, sessionName)) {
      this.logLifecycle(companyId, 'warn', `${event}_skipped_no_page`);
      return null;
    }

    try {
      const probe = (await page.evaluate(() => {
        const globalWindow = window as typeof window & {
          WAPI?: {
            getWAVersion?: () => string;
          };
          Store?: {
            VERSION?: string;
          };
          WPP?: {
            version?: string;
          };
        };
        const bodyText = document.body?.innerText || '';
        let storeVersion: string | null = null;
        let storeVersionError: string | null = null;
        try {
          storeVersion = globalWindow.Store?.VERSION ?? null;
        } catch (error) {
          storeVersionError = error instanceof Error ? error.message : String(error);
        }
        const qrCandidates = [
          'canvas[aria-label*="Scan"]',
          'canvas',
          '[data-ref]',
          'img[alt*="QR"]',
        ];
        const hasQrCandidate = qrCandidates.some((selector) => Boolean(document.querySelector(selector)));

        return {
          location: window.location.href,
          title: document.title,
          readyState: document.readyState,
          hasStore: typeof globalWindow.Store !== 'undefined',
          hasWapi: typeof globalWindow.WAPI !== 'undefined',
          hasWpp: typeof globalWindow.WPP !== 'undefined',
          waVersion:
            globalWindow.WAPI?.getWAVersion?.() ||
            globalWindow.WPP?.version ||
            storeVersion ||
            null,
          storeVersion,
          storeVersionError,
          hasQrCandidate,
          bodySnippet: bodyText.slice(0, 500),
        };
      })) as InjectionDiagnostic;

      this.logLifecycle(companyId, 'log', event, probe);
      if (probe.storeVersionError) {
        this.logLifecycle(companyId, 'warn', `${event}_store_version_read_failed`, {
          error: probe.storeVersionError,
        });
      }
      return probe;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logLifecycle(companyId, 'error', `${event}_failed`, {
        error: message,
      });
      return null;
    }
  }

  private buildStableUserDataDir(companyId: string) {
    return path.join(BROWSER_PROFILE_BASE_DIR, `company-${companyId}`);
  }

  private async sleep(ms: number) {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}
