import { Injectable } from '@nestjs/common';
import { Whatsapp as WppWhatsapp } from '@wppconnect-team/wppconnect';

export type WhatsappStatus =
  | 'DISCONNECTED'
  | 'CONNECTING'
  | 'QR_READY'
  | 'QR_REQUIRED'
  | 'AUTHENTICATING'
  | 'CONNECTED'
  | 'UNPAIRED';

export type SessionLifecycleState =
  | 'idle'
  | 'starting'
  | 'browser_ready'
  | 'whatsapp_loading'
  | 'qr_ready'
  | 'pairing'
  | 'connected'
  | 'needs_new_qr'
  | 'disconnected'
  | 'failed'
  | 'cleaning_up';

export interface SessionDiagnosticSnapshot {
  companyId: string;
  sessionName: string | null;
  correlationId: string | null;
  currentState: SessionLifecycleState;
  status: WhatsappStatus;
  hasClient: boolean;
  hasBrowser: boolean;
  hasPage: boolean;
  hasQr: boolean;
  qrAgeMs: number | null;
  qrExpiresAt: string | null;
  lastEvent: string | null;
  lastError: string | null;
  lastTransitionAt: string;
  lastKnownConnectionState: string | null;
  failureReason: string | null;
  versionWarning: string | null;
  creationInFlight: boolean;
  cleanupInFlight: boolean;
  timeline: Array<{
    at: string;
    event: string;
    state: SessionLifecycleState;
    status: WhatsappStatus;
  }>;
}

export interface SessionRuntimeContext {
  companyId: string;
  sessionName: string | null;
  correlationId: string | null;
  lifecycleState: SessionLifecycleState;
  status: WhatsappStatus;
  client: WppWhatsapp | null;
  qrCode: string | null;
  qrGeneratedAt: number | null;
  qrExpiresAt: number | null;
  lastEvent: string | null;
  lastError: string | null;
  lastTransitionAt: number;
  lastKnownConnectionState: string | null;
  failureReason: string | null;
  versionWarning: string | null;
  startPromise: Promise<WppWhatsapp | null> | null;
  cleanupPromise: Promise<void> | null;
  qrTimeoutTimer: NodeJS.Timeout | null;
  timeline: Array<{
    at: number;
    event: string;
    state: SessionLifecycleState;
    status: WhatsappStatus;
  }>;
}

@Injectable()
export class WppSessionStateManager {
  private readonly contexts = new Map<string, SessionRuntimeContext>();

  getOrCreate(companyId: string): SessionRuntimeContext {
    const existing = this.contexts.get(companyId);
    if (existing) {
      return existing;
    }

    const created: SessionRuntimeContext = {
      companyId,
      sessionName: null,
      correlationId: null,
      lifecycleState: 'idle',
      status: 'DISCONNECTED',
      client: null,
      qrCode: null,
      qrGeneratedAt: null,
      qrExpiresAt: null,
      lastEvent: null,
      lastError: null,
      lastTransitionAt: Date.now(),
      lastKnownConnectionState: null,
      failureReason: null,
      versionWarning: null,
      startPromise: null,
      cleanupPromise: null,
      qrTimeoutTimer: null,
      timeline: [],
    };

    this.contexts.set(companyId, created);
    return created;
  }

  get(companyId: string) {
    return this.contexts.get(companyId) || null;
  }

  setSessionIdentity(companyId: string, sessionName: string, correlationId: string) {
    const ctx = this.getOrCreate(companyId);
    ctx.sessionName = sessionName;
    ctx.correlationId = correlationId;
    return ctx;
  }

  transition(
    companyId: string,
    nextState: SessionLifecycleState,
    nextStatus: WhatsappStatus,
    event: string,
    details?: {
      lastError?: string | null;
      failureReason?: string | null;
      lastKnownConnectionState?: string | null;
      versionWarning?: string | null;
    },
  ) {
    const ctx = this.getOrCreate(companyId);
    ctx.lifecycleState = nextState;
    ctx.status = nextStatus;
    ctx.lastEvent = event;
    ctx.lastTransitionAt = Date.now();
    ctx.timeline.push({
      at: ctx.lastTransitionAt,
      event,
      state: nextState,
      status: nextStatus,
    });
    if (ctx.timeline.length > 50) {
      ctx.timeline.shift();
    }

    if (typeof details?.lastError !== 'undefined') {
      ctx.lastError = details.lastError;
    }

    if (typeof details?.failureReason !== 'undefined') {
      ctx.failureReason = details.failureReason;
    }

    if (typeof details?.lastKnownConnectionState !== 'undefined') {
      ctx.lastKnownConnectionState = details.lastKnownConnectionState;
    }

    if (typeof details?.versionWarning !== 'undefined') {
      ctx.versionWarning = details.versionWarning;
    }

    return ctx;
  }

  setQr(companyId: string, qrCode: string, generatedAt: number, expiresAt: number) {
    const ctx = this.getOrCreate(companyId);
    ctx.qrCode = qrCode;
    ctx.qrGeneratedAt = generatedAt;
    ctx.qrExpiresAt = expiresAt;
    return ctx;
  }

  clearQr(companyId: string) {
    const ctx = this.getOrCreate(companyId);
    ctx.qrCode = null;
    ctx.qrGeneratedAt = null;
    ctx.qrExpiresAt = null;
    return ctx;
  }

  setClient(companyId: string, client: WppWhatsapp | null) {
    const ctx = this.getOrCreate(companyId);
    ctx.client = client;
    return ctx;
  }

  setStartPromise(companyId: string, startPromise: Promise<WppWhatsapp | null> | null) {
    const ctx = this.getOrCreate(companyId);
    ctx.startPromise = startPromise;
    return ctx;
  }

  setCleanupPromise(companyId: string, cleanupPromise: Promise<void> | null) {
    const ctx = this.getOrCreate(companyId);
    ctx.cleanupPromise = cleanupPromise;
    return ctx;
  }

  setQrTimeoutTimer(companyId: string, qrTimeoutTimer: NodeJS.Timeout | null) {
    const ctx = this.getOrCreate(companyId);
    ctx.qrTimeoutTimer = qrTimeoutTimer;
    return ctx;
  }

  clear(companyId: string) {
    const ctx = this.contexts.get(companyId);
    if (ctx?.qrTimeoutTimer) {
      clearTimeout(ctx.qrTimeoutTimer);
    }
    this.contexts.delete(companyId);
  }

  listCompanyIds() {
    return [...this.contexts.keys()];
  }

  snapshot(companyId: string): SessionDiagnosticSnapshot {
    const ctx = this.getOrCreate(companyId);
    const pageLike = (ctx.client as unknown as { page?: { isClosed?: () => boolean; browser?: () => unknown } } | null)?.page;
    const hasPage = Boolean(pageLike && !(pageLike.isClosed?.() ?? false));
    const hasBrowser = Boolean(hasPage && pageLike?.browser?.());
    const qrAgeMs = ctx.qrGeneratedAt ? Date.now() - ctx.qrGeneratedAt : null;

    return {
      companyId,
      sessionName: ctx.sessionName,
      correlationId: ctx.correlationId,
      currentState: ctx.lifecycleState,
      status: ctx.status,
      hasClient: Boolean(ctx.client),
      hasBrowser,
      hasPage,
      hasQr: Boolean(ctx.qrCode),
      qrAgeMs,
      qrExpiresAt: ctx.qrExpiresAt ? new Date(ctx.qrExpiresAt).toISOString() : null,
      lastEvent: ctx.lastEvent,
      lastError: ctx.lastError,
      lastTransitionAt: new Date(ctx.lastTransitionAt).toISOString(),
      lastKnownConnectionState: ctx.lastKnownConnectionState,
      failureReason: ctx.failureReason,
      versionWarning: ctx.versionWarning,
      creationInFlight: Boolean(ctx.startPromise),
      cleanupInFlight: Boolean(ctx.cleanupPromise),
      timeline: ctx.timeline.map((item) => ({
        at: new Date(item.at).toISOString(),
        event: item.event,
        state: item.state,
        status: item.status,
      })),
    };
  }
}
