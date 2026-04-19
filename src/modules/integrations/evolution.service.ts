import {
  BadRequestException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  Prisma,
  WhatsappInstance,
  WhatsappInstanceStatus,
} from '@prisma/client';
import axios, { AxiosError, AxiosInstance } from 'axios';
import { createHash, createHmac } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { PlatformQueueService } from '../queue/platform-queue.service';

type EvolutionEventName =
  | 'QRCODE_UPDATED'
  | 'CONNECTION_UPDATE'
  | 'MESSAGES_UPSERT';

type EvolutionMessage = {
  pushName?: string;
  key?: {
    id?: string;
    fromMe?: boolean;
    remoteJid?: string;
  };
  message?: Record<string, unknown>;
  messageTimestamp?: string | number;
};

type EvolutionWebhookPayload = {
  event?: string;
  instance?: string;
  data?: {
    state?: string;
    qrcode?: {
      base64?: string;
    };
    pairingCode?: string;
    code?: string;
    messages?: EvolutionMessage[];
  };
};

type ConnectionSnapshot = {
  instanceName: string | null;
  connected: boolean;
  method: 'evolution' | null;
  state: string;
  status: string;
  qrCode: string | null;
  pairingCode: string | null;
  qrRequired: boolean;
  ready: boolean;
  updatedAt: string | null;
  failureReason: string | null;
};

const WEBHOOK_EVENTS: EvolutionEventName[] = [
  'QRCODE_UPDATED',
  'MESSAGES_UPSERT',
  'CONNECTION_UPDATE',
];

type EvolutionHttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

type EvolutionRequestOptions = {
  companyId?: string;
  method: EvolutionHttpMethod;
  operation: string;
  path: string;
  data?: Record<string, unknown>;
  params?: Record<string, string | number | boolean | undefined>;
  timeoutMs?: number;
  maxRetries?: number;
};

type EvolutionInfoResponse = {
  version?: string;
};

type EvolutionConnectionStateResponse = {
  instance?: {
    instanceName?: string;
    state?: string;
  };
};

type EvolutionRemoteInstance = {
  instanceName: string;
  state: string;
};

type EvolutionRemoteLookup = {
  exists: boolean;
  state: string;
  source: 'connectionState' | 'fetchInstances' | 'created';
};

@Injectable()
export class EvolutionService {
  private readonly logger = new Logger(EvolutionService.name);
  private readonly api: AxiosInstance;
  private readonly evolutionApiUrl: string | null;
  private readonly evolutionApiKey: string | null;
  private readonly evolutionTimeoutMs: number;
  private readonly evolutionMaxRetries: number;
  private readonly evolutionInfoTtlMs: number;
  private remoteInfoCache: { version: string | null; checkedAt: number } | null =
    null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly eventEmitter: EventEmitter2,
    private readonly platformQueue: PlatformQueueService,
  ) {
    this.evolutionApiUrl = this.asString(
      this.configService.get<string>('EVOLUTION_API_URL'),
    );
    this.evolutionApiKey = this.asString(
      this.configService.get<string>('EVOLUTION_API_KEY'),
    );
    this.evolutionTimeoutMs = this.readPositiveInteger(
      this.configService.get<string>('EVOLUTION_API_TIMEOUT_MS'),
      10000,
    );
    this.evolutionMaxRetries = this.readBoundedInteger(
      this.configService.get<string>('EVOLUTION_API_MAX_RETRIES'),
      2,
      0,
      5,
    );
    this.evolutionInfoTtlMs = this.readPositiveInteger(
      this.configService.get<string>('EVOLUTION_API_INFO_TTL_MS'),
      300000,
    );

    this.api = axios.create({
      baseURL: this.evolutionApiUrl || undefined,
      headers: {
        ...(this.evolutionApiKey
          ? {
              apikey: this.evolutionApiKey,
              Authorization: `Bearer ${this.evolutionApiKey}`,
            }
          : {}),
        'Content-Type': 'application/json',
      },
      timeout: this.evolutionTimeoutMs,
    });
  }

  async connectInstance(companyId: string): Promise<ConnectionSnapshot> {
    this.ensureConfigured();

    const instance = await this.ensureInstanceRecord(companyId);
    await this.ensureRemoteInstance(instance);
    await this.configureWebhook(instance);
    await this.requestConnection(instance);

    return this.getConnectionSnapshot(companyId, true);
  }

  async getConnectionSnapshot(
    companyId: string,
    syncRemote = true,
  ): Promise<ConnectionSnapshot> {
    const instance = await this.prisma.whatsappInstance.findUnique({
      where: { companyId },
    });

    if (!instance) {
      return this.buildSnapshot(null);
    }

    const current = syncRemote
      ? await this.syncRemoteState(instance).catch(() => instance)
      : instance;

    return this.buildSnapshot(current);
  }

  async getQRCode(companyId: string) {
    const snapshot = await this.getConnectionSnapshot(companyId, false);
    return {
      ...snapshot,
      qrcode: snapshot.qrCode,
      qrCode: snapshot.qrCode,
    };
  }

  async sendTextMessage(companyId: string, to: string, text: string) {
    this.ensureConfigured();

    const instance = await this.ensureInstanceRecord(companyId);
    const number = this.normalizeOutboundNumber(to);
    const trimmedText = text.trim();

    if (!trimmedText) {
      throw new BadRequestException('Mensagem vazia');
    }

    const response = await this.requestEvolution<Record<string, unknown>>({
      companyId,
      method: 'POST',
      operation: 'send-text',
      path: `message/sendText/${encodeURIComponent(instance.instanceName)}`,
      data: {
        number,
        text: trimmedText,
        delay: 0,
        linkPreview: false,
      },
      maxRetries: 0,
    });

    await this.prisma.usageQuota.upsert({
      where: { companyId },
      update: {
        whatsappMessagesSent: { increment: 1 },
      },
      create: {
        companyId,
        currentTier: 'COMUM',
        billingCycleEnd: this.addDays(new Date(), 30),
        whatsappMessagesSent: 1,
      },
    }).catch(() => undefined);

    return response;
  }

  async disconnectInstance(companyId: string): Promise<void> {
    this.ensureConfigured();

    const instance = await this.prisma.whatsappInstance.findUnique({
      where: { companyId },
    });

    if (!instance) {
      return;
    }

    await this.requestEvolution({
      companyId,
      method: 'DELETE',
      operation: 'logout-instance',
      path: `instance/logout/${encodeURIComponent(instance.instanceName)}`,
      maxRetries: 0,
    }).catch(() => undefined);
    await this.requestEvolution({
      companyId,
      method: 'DELETE',
      operation: 'delete-instance',
      path: `instance/delete/${encodeURIComponent(instance.instanceName)}`,
      maxRetries: 0,
    }).catch(() => undefined);

    await this.prisma.$transaction([
      this.prisma.company.update({
        where: { id: companyId },
        data: { evolutionConnected: false },
      }),
      this.prisma.whatsappInstance.update({
        where: { id: instance.id },
        data: {
          status: WhatsappInstanceStatus.DISCONNECTED,
          connectionState: 'close',
          qrCode: null,
          pairingCode: null,
          lastError: null,
        },
      }),
    ]).catch(() => undefined);

    this.eventEmitter.emit('whatsapp.status.updated', {
      companyId,
      status: 'close',
    });
  }

  async processWebhook(
    payload: Record<string, unknown>,
    token?: string | null,
  ): Promise<void> {
    const event = this.asEvolutionEvent(payload.event);
    const instanceName = this.asString(payload.instance);

    if (!event || !instanceName) {
      return;
    }

    const instance = await this.prisma.whatsappInstance.findUnique({
      where: { instanceName },
    });

    if (!instance) {
      this.logger.warn(`Webhook Evolution ignorado para instancia desconhecida: ${instanceName}`);
      return;
    }

    this.assertWebhookToken(instance, token);

    const data = (payload.data as EvolutionWebhookPayload['data']) || {};

    await this.prisma.whatsappInstance.update({
      where: { id: instance.id },
      data: { lastWebhookAt: new Date() },
    }).catch(() => undefined);

    if (event === 'QRCODE_UPDATED') {
      const qrCode = this.normalizeQrCode(
        this.asString(data?.qrcode?.base64) ||
          this.asString(data?.code),
      );
      const pairingCode = this.asString(data?.pairingCode);

      await this.prisma.whatsappInstance.update({
        where: { id: instance.id },
        data: {
          status: qrCode ? WhatsappInstanceStatus.QR_READY : WhatsappInstanceStatus.CONNECTING,
          connectionState: 'connecting',
          qrCode,
          pairingCode,
          lastError: null,
        },
      });

      if (qrCode) {
        this.eventEmitter.emit('whatsapp.qr.generated', {
          companyId: instance.companyId,
          qrCode,
          attempts: 0,
          sessionName: instance.instanceName,
        });
      }

      this.eventEmitter.emit('whatsapp.status.updated', {
        companyId: instance.companyId,
        status: qrCode ? 'qr_ready' : 'connecting',
      });
      return;
    }

    if (event === 'CONNECTION_UPDATE') {
      const state = this.asString(data?.state) || 'close';
      const status = this.mapInstanceStatus(state, instance.qrCode);
      const connected = state === 'open';

      await this.prisma.$transaction([
        this.prisma.company.update({
          where: { id: instance.companyId },
          data: {
            evolutionConnected: connected,
            lastConnectedAt: connected ? new Date() : null,
          },
        }),
        this.prisma.whatsappInstance.update({
          where: { id: instance.id },
          data: {
            status,
            connectionState: state,
            qrCode: connected ? null : instance.qrCode,
            pairingCode: connected ? null : instance.pairingCode,
            lastConnectionAt: connected ? new Date() : instance.lastConnectionAt,
            lastError: status === WhatsappInstanceStatus.ERROR ? state : null,
          },
        }),
      ]).catch(() => undefined);

      this.eventEmitter.emit('whatsapp.status.updated', {
        companyId: instance.companyId,
        status: state,
      });
      return;
    }

    if (event !== 'MESSAGES_UPSERT') {
      return;
    }

    const messages = Array.isArray(data?.messages) ? data.messages : [];

    for (const message of messages) {
      const parsed = this.parseInboundMessage(message);
      if (!parsed) {
        continue;
      }

      try {
        const created = await this.prisma.whatsappMessageEvent.create({
          data: {
            companyId: instance.companyId,
            instanceId: instance.id,
            externalMessageId: parsed.externalMessageId,
            remoteJid: parsed.remoteJid,
            remoteNumber: parsed.remoteNumber,
            pushName: parsed.pushName,
            messageType: parsed.messageType,
            text: parsed.text,
            fromMe: false,
            eventName: event,
            messageTimestamp: parsed.messageTimestamp,
            rawPayload: message as Prisma.InputJsonValue,
          },
        });

        await this.platformQueue.enqueueWhatsappMessage({
          messageEventId: created.id,
          companyId: instance.companyId,
        });
      } catch (error) {
        if (this.isUniqueConstraintError(error)) {
          continue;
        }
        throw error;
      }
    }
  }

  private async ensureInstanceRecord(companyId: string): Promise<WhatsappInstance> {
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { id: true },
    });

    if (!company) {
      throw new BadRequestException('Empresa invalida');
    }

    const instanceName = this.getInstanceName(companyId);
    const webhookTokenHash = this.hashToken(this.deriveWebhookToken(instanceName));

    const existing = await this.prisma.whatsappInstance.findUnique({
      where: { companyId },
    });

    if (existing) {
      if (existing.webhookTokenHash !== webhookTokenHash) {
        return this.prisma.whatsappInstance.update({
          where: { id: existing.id },
          data: { webhookTokenHash },
        });
      }

      return existing;
    }

    return this.prisma.whatsappInstance.create({
      data: {
        companyId,
        instanceName,
        webhookTokenHash,
        status: WhatsappInstanceStatus.DISCONNECTED,
        connectionState: 'close',
      },
    });
  }

  private async ensureRemoteInstance(instance: WhatsappInstance) {
    const remote = await this.resolveRemoteInstance(
      instance.instanceName,
      instance.companyId,
    );
    if (remote.exists) {
      return remote;
    }

    const webhookToken = this.deriveWebhookToken(instance.instanceName);
    const webhookUrl = this.buildWebhookUrl(instance.instanceName, webhookToken);

    try {
      await this.requestEvolution({
        companyId: instance.companyId,
        method: 'POST',
        operation: 'create-instance',
        path: 'instance/create',
        data: {
          instanceName: instance.instanceName,
          integration: 'WHATSAPP-BAILEYS',
          qrcode: true,
          rejectCall: false,
          groupsIgnore: true,
          alwaysOnline: false,
          readMessages: false,
          readStatus: false,
          syncFullHistory: false,
          webhook: {
            url: webhookUrl,
            byEvents: false,
            base64: true,
            events: WEBHOOK_EVENTS,
          },
        } as Record<string, unknown>,
        maxRetries: 0,
      });
    } catch (error) {
      if (!this.isInstanceAlreadyExistsError(error)) {
        throw error;
      }

      this.logger.warn(
        `Evolution create-instance retornou conflito para ${instance.instanceName}; seguindo com a instancia remota existente.`,
      );
    }

    await this.prisma.whatsappInstance.update({
      where: { id: instance.id },
      data: {
        status: WhatsappInstanceStatus.CONNECTING,
        connectionState: 'connecting',
        lastError: null,
      },
    }).catch(() => undefined);

    return {
      exists: true,
      state: 'connecting',
      source: 'created',
    } satisfies EvolutionRemoteLookup;
  }

  private async configureWebhook(instance: WhatsappInstance) {
    const webhookToken = this.deriveWebhookToken(instance.instanceName);
    const webhookUrl = this.buildWebhookUrl(instance.instanceName, webhookToken);

    await this.requestEvolution({
      companyId: instance.companyId,
      method: 'POST',
      operation: 'set-webhook',
      path: `webhook/set/${encodeURIComponent(instance.instanceName)}`,
      data: {
        enabled: true,
        url: webhookUrl,
        webhook_by_events: false,
        webhook_base64: true,
        webhookByEvents: false,
        webhookBase64: true,
        events: WEBHOOK_EVENTS,
      },
      maxRetries: 0,
    });
  }

  private async requestConnection(instance: WhatsappInstance) {
    const response = await this.requestEvolution<{
      pairingCode?: string;
      code?: string;
    }>({
      companyId: instance.companyId,
      method: 'GET',
      operation: 'connect-instance',
      path: `instance/connect/${encodeURIComponent(instance.instanceName)}`,
    });
    const pairingCode = this.asString(response?.pairingCode);
    const qrCode = this.normalizeQrCode(this.asString(response?.code));

    await this.prisma.whatsappInstance.update({
      where: { id: instance.id },
      data: {
        status: qrCode ? WhatsappInstanceStatus.QR_READY : WhatsappInstanceStatus.CONNECTING,
        connectionState: 'connecting',
        pairingCode,
        qrCode: qrCode || instance.qrCode,
        lastError: null,
      },
    }).catch(() => undefined);
  }

  private async remoteInstanceExists(instanceName: string): Promise<boolean> {
    const remote = await this.resolveRemoteInstance(instanceName);
    return remote.exists;
  }

  private buildSnapshot(instance: WhatsappInstance | null): ConnectionSnapshot {
    if (!instance) {
      return {
        instanceName: null,
        connected: false,
        method: null,
        state: 'close',
        status: 'disconnected',
        qrCode: null,
        pairingCode: null,
        qrRequired: false,
        ready: false,
        updatedAt: null,
        failureReason: null,
      };
    }

    const connected = instance.connectionState === 'open';
    const qrRequired =
      !connected &&
      (instance.status === WhatsappInstanceStatus.QR_READY ||
        Boolean(instance.qrCode));

    return {
      instanceName: instance.instanceName,
      connected,
      method: 'evolution',
      state: instance.connectionState,
      status: this.mapPublicStatus(instance.status),
      qrCode: instance.qrCode,
      pairingCode: instance.pairingCode,
      qrRequired,
      ready: connected || qrRequired,
      updatedAt: instance.updatedAt.toISOString(),
      failureReason: instance.lastError,
    };
  }

  private parseInboundMessage(message: EvolutionMessage) {
    const externalMessageId = this.asString(message?.key?.id);
    const remoteJid = this.asString(message?.key?.remoteJid);
    const fromMe = Boolean(message?.key?.fromMe);

    if (!externalMessageId || !remoteJid || fromMe || this.shouldIgnoreRemoteJid(remoteJid)) {
      return null;
    }

    const content = this.unwrapMessageContent(message.message);
    const text = this.extractText(content);
    if (!text) {
      return null;
    }

    return {
      externalMessageId,
      remoteJid,
      remoteNumber: this.normalizeInboundNumber(remoteJid),
      pushName: this.asString(message.pushName),
      messageType: this.detectMessageType(content),
      text,
      messageTimestamp: this.parseMessageTimestamp(message.messageTimestamp),
    };
  }

  private unwrapMessageContent(
    message: Record<string, unknown> | undefined,
  ): Record<string, unknown> | null {
    let current = message || null;

    for (let depth = 0; depth < 5 && current; depth += 1) {
      const nested =
        this.asRecord(current.ephemeralMessage)?.message ||
        this.asRecord(current.viewOnceMessage)?.message ||
        this.asRecord(current.viewOnceMessageV2)?.message ||
        this.asRecord(current.viewOnceMessageV2Extension)?.message;

      if (!nested || typeof nested !== 'object') {
        break;
      }

      current = nested as Record<string, unknown>;
    }

    return current;
  }

  private extractText(content: Record<string, unknown> | null): string | null {
    if (!content) {
      return null;
    }

    const candidates = [
      this.asString(content.conversation),
      this.asString(this.asRecord(content.extendedTextMessage)?.text),
      this.asString(this.asRecord(content.imageMessage)?.caption),
      this.asString(this.asRecord(content.videoMessage)?.caption),
      this.asString(this.asRecord(content.documentMessage)?.caption),
      this.asString(this.asRecord(content.buttonsResponseMessage)?.selectedDisplayText),
      this.asString(this.asRecord(content.listResponseMessage)?.title),
      this.asString(this.asRecord(content.templateButtonReplyMessage)?.selectedDisplayText),
      this.asString(this.asRecord(content.interactiveResponseMessage)?.body),
    ];

    return candidates.find((item) => Boolean(item)) || null;
  }

  private detectMessageType(content: Record<string, unknown> | null): string | null {
    if (!content) {
      return null;
    }

    const messageType = Object.keys(content).find((key) => key !== 'messageContextInfo');
    return messageType || null;
  }

  private shouldIgnoreRemoteJid(remoteJid: string): boolean {
    return (
      remoteJid.includes('@g.us') ||
      remoteJid.includes('@newsletter') ||
      remoteJid.includes('status@broadcast')
    );
  }

  private mapInstanceStatus(
    state: string,
    qrCode: string | null,
  ): WhatsappInstanceStatus {
    if (state === 'open') {
      return WhatsappInstanceStatus.CONNECTED;
    }
    if (qrCode) {
      return WhatsappInstanceStatus.QR_READY;
    }
    if (['connecting', 'pairing', 'init'].includes(state)) {
      return WhatsappInstanceStatus.CONNECTING;
    }
    if (['close', 'closed', 'logout'].includes(state)) {
      return WhatsappInstanceStatus.DISCONNECTED;
    }
    return WhatsappInstanceStatus.ERROR;
  }

  private mapPublicStatus(status: WhatsappInstanceStatus): string {
    switch (status) {
      case WhatsappInstanceStatus.CONNECTED:
        return 'connected';
      case WhatsappInstanceStatus.QR_READY:
        return 'qr_ready';
      case WhatsappInstanceStatus.CONNECTING:
        return 'connecting';
      case WhatsappInstanceStatus.ERROR:
        return 'error';
      default:
        return 'disconnected';
    }
  }

  private getInstanceName(companyId: string): string {
    return `nextlevel-${companyId}`;
  }

  private buildWebhookUrl(instanceName: string, token: string): string {
    const url = new URL(
      this.normalizeRequestPath('api/evolution/webhook'),
      `${this.getBackendUrl()}/`,
    );
    url.searchParams.set('instance', instanceName);
    url.searchParams.set('token', token);
    return url.toString();
  }

  private deriveWebhookToken(instanceName: string): string {
    const secret =
      this.configService.get<string>('EVOLUTION_WEBHOOK_SECRET') ||
      this.configService.get<string>('JWT_SECRET');

    if (!secret) {
      throw new BadRequestException(
        'EVOLUTION_WEBHOOK_SECRET ou JWT_SECRET precisa estar configurado',
      );
    }

    return createHmac('sha256', secret).update(instanceName).digest('hex');
  }

  private assertWebhookToken(instance: WhatsappInstance, token?: string | null) {
    const normalizedToken = this.asString(token);
    if (!normalizedToken) {
      throw new UnauthorizedException('Webhook Evolution sem token');
    }

    const tokenHash = this.hashToken(normalizedToken);
    if (tokenHash !== instance.webhookTokenHash) {
      throw new UnauthorizedException('Token invalido no webhook Evolution');
    }
  }

  private normalizeQrCode(value: string | null): string | null {
    if (!value) {
      return null;
    }

    if (value.startsWith('data:')) {
      return value;
    }

    if (/^[A-Za-z0-9+/=]+$/.test(value) && value.length > 100) {
      return `data:image/png;base64,${value}`;
    }

    return null;
  }

  private normalizeOutboundNumber(value: string): string {
    const digits = value.replace(/\D/g, '');
    if (!digits) {
      throw new BadRequestException('Numero de destino invalido');
    }
    return digits;
  }

  private normalizeInboundNumber(value: string): string {
    return value.replace('@s.whatsapp.net', '').replace('@c.us', '');
  }

  private parseMessageTimestamp(value: unknown): Date | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return new Date(value * 1000);
    }

    if (typeof value === 'string' && value.trim()) {
      const numeric = Number(value);
      if (Number.isFinite(numeric)) {
        return new Date(numeric * 1000);
      }

      const parsed = new Date(value);
      if (!Number.isNaN(parsed.getTime())) {
        return parsed;
      }
    }

    return null;
  }

  private asString(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  }

  private asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  }

  private asEvolutionEvent(value: unknown): EvolutionEventName | null {
    if (
      value === 'QRCODE_UPDATED' ||
      value === 'CONNECTION_UPDATE' ||
      value === 'MESSAGES_UPSERT'
    ) {
      return value;
    }

    return null;
  }

  private getBackendUrl(): string {
    const backendUrl =
      this.asString(this.configService.get<string>('BACKEND_URL')) ||
      this.asString(this.configService.get<string>('APP_URL')) ||
      this.asString(this.configService.get<string>('PUBLIC_API_URL'));

    if (!backendUrl) {
      throw new BadRequestException('BACKEND_URL nao configurado no servidor');
    }

    return backendUrl.replace(/\/+$/, '');
  }

  private ensureConfigured(): void {
    if (!this.isConfigured()) {
      if (!this.evolutionApiUrl) {
        throw new BadRequestException('EVOLUTION_API_URL nao configurada no servidor');
      }

      throw new BadRequestException('EVOLUTION_API_KEY nao configurada no servidor');
    }
  }

  private isConfigured(): boolean {
    return Boolean(this.evolutionApiUrl && this.evolutionApiKey);
  }

  private async syncRemoteState(instance: WhatsappInstance): Promise<WhatsappInstance> {
    if (!this.isConfigured()) {
      return instance;
    }

    try {
      const remote = await this.resolveRemoteInstance(
        instance.instanceName,
        instance.companyId,
      );

      if (!remote.exists) {
        return this.persistDisconnectedState(instance);
      }

      return this.persistRemoteState(instance, remote.state);
    } catch (error) {
      this.logger.warn(
        `Falha ao sincronizar estado remoto da Evolution para ${instance.companyId}: ${
          (error as Error)?.message || 'erro desconhecido'
        }`,
      );
      return instance;
    }
  }

  private async resolveRemoteInstance(
    instanceName: string,
    companyId?: string,
  ): Promise<EvolutionRemoteLookup> {
    try {
      const response = await this.requestEvolution<EvolutionConnectionStateResponse>({
        companyId,
        method: 'GET',
        operation: 'connection-state',
        path: `instance/connectionState/${encodeURIComponent(instanceName)}`,
      });
      return {
        exists: true,
        state: this.normalizeRemoteState(this.asString(response?.instance?.state)),
        source: 'connectionState',
      };
    } catch (error) {
      if (this.isAuthenticationError(error)) {
        throw error;
      }

      if (!this.shouldFallbackToFetchInstances(error)) {
        throw error;
      }
    }

    const version = await this.detectRemoteVersion(companyId);
    this.logger.warn(
      `Evolution fallback: connectionState indisponivel para ${instanceName}; usando fetchInstances${
        version ? ` (versao ${version})` : ''
      }.`,
    );

    const remoteInstance = await this.fetchRemoteInstance(instanceName, companyId);
    if (!remoteInstance) {
      return {
        exists: false,
        state: 'close',
        source: 'fetchInstances',
      };
    }

    return {
      exists: true,
      state: remoteInstance.state,
      source: 'fetchInstances',
    };
  }

  private async fetchRemoteInstance(
    instanceName: string,
    companyId?: string,
  ): Promise<EvolutionRemoteInstance | null> {
    const response = await this.requestEvolution<unknown>({
      companyId,
      method: 'GET',
      operation: 'fetch-instances',
      path: 'instance/fetchInstances',
      params: { instanceName },
      maxRetries: 0,
    });

    const match = this.extractRemoteInstances(response).find(
      (item) => item.instanceName === instanceName,
    );

    return match || null;
  }

  private extractRemoteInstances(payload: unknown): EvolutionRemoteInstance[] {
    const responseRecord = this.asRecord(payload);
    const candidates = Array.isArray(payload)
      ? payload
      : Array.isArray(responseRecord?.response)
        ? responseRecord.response
        : responseRecord?.instance
          ? [responseRecord.instance]
          : [];

    const instances: EvolutionRemoteInstance[] = [];

    for (const candidate of candidates) {
      const instanceRecord =
        this.asRecord(this.asRecord(candidate)?.instance) || this.asRecord(candidate);
      const instanceName = this.asString(instanceRecord?.instanceName);

      if (!instanceRecord || !instanceName) {
        continue;
      }

      const state =
        this.asString(instanceRecord.state) ||
        this.asString(instanceRecord.status) ||
        'close';

      instances.push({
        instanceName,
        state: this.normalizeRemoteState(state),
      });
    }

    return instances;
  }

  private normalizeRemoteState(value: string | null): string {
    const normalized = value?.trim().toLowerCase();

    if (!normalized) {
      return 'close';
    }

    if (normalized === 'connected') {
      return 'open';
    }

    if (normalized === 'disconnected') {
      return 'close';
    }

    if (normalized === 'created') {
      return 'connecting';
    }

    return normalized;
  }

  private async persistRemoteState(
    instance: WhatsappInstance,
    rawState: string,
  ): Promise<WhatsappInstance> {
    const state = this.normalizeRemoteState(rawState);
    const status = this.mapInstanceStatus(state, instance.qrCode);
    const connected = state === 'open';

    const [, updated] = await this.prisma.$transaction([
      this.prisma.company.update({
        where: { id: instance.companyId },
        data: {
          evolutionConnected: connected,
          lastConnectedAt: connected ? new Date() : null,
        },
      }),
      this.prisma.whatsappInstance.update({
        where: { id: instance.id },
        data: {
          status,
          connectionState: state,
          qrCode: connected ? null : instance.qrCode,
          pairingCode: connected ? null : instance.pairingCode,
          lastConnectionAt: connected ? new Date() : instance.lastConnectionAt,
          lastError: null,
        },
      }),
    ]);

    return updated;
  }

  private async persistDisconnectedState(
    instance: WhatsappInstance,
  ): Promise<WhatsappInstance> {
    const [, updated] = await this.prisma.$transaction([
      this.prisma.company.update({
        where: { id: instance.companyId },
        data: {
          evolutionConnected: false,
        },
      }),
      this.prisma.whatsappInstance.update({
        where: { id: instance.id },
        data: {
          status: WhatsappInstanceStatus.DISCONNECTED,
          connectionState: 'close',
          qrCode: null,
          pairingCode: null,
          lastError: null,
        },
      }),
    ]);

    return updated;
  }

  private async detectRemoteVersion(companyId?: string): Promise<string | null> {
    if (!this.isConfigured()) {
      return null;
    }

    const now = Date.now();
    if (
      this.remoteInfoCache &&
      now - this.remoteInfoCache.checkedAt < this.evolutionInfoTtlMs
    ) {
      return this.remoteInfoCache.version;
    }

    try {
      const response = await this.requestEvolution<EvolutionInfoResponse>({
        companyId,
        method: 'GET',
        operation: 'detect-version',
        path: '',
        maxRetries: 0,
        timeoutMs: Math.min(this.evolutionTimeoutMs, 5000),
      });
      const version = this.asString(response?.version);
      this.remoteInfoCache = {
        version,
        checkedAt: now,
      };
      return version;
    } catch {
      this.remoteInfoCache = {
        version: null,
        checkedAt: now,
      };
      return null;
    }
  }

  private async requestEvolution<TResponse = unknown>({
    companyId,
    method,
    operation,
    path,
    data,
    params,
    timeoutMs,
    maxRetries,
  }: EvolutionRequestOptions): Promise<TResponse> {
    this.ensureConfigured();

    const normalizedPath = this.normalizeRequestPath(path);
    const fullUrl = this.buildEvolutionUrl(normalizedPath, params);
    const attempts = (maxRetries ?? this.evolutionMaxRetries) + 1;
    let lastError: unknown;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      this.logger.warn(`Evolution request: ${method} ${fullUrl}`);

      const startedAt = Date.now();

      try {
        const response = await this.api.request<TResponse>({
          method,
          url: normalizedPath,
          data,
          params,
          timeout: timeoutMs ?? this.evolutionTimeoutMs,
        });

        return response.data;
      } catch (error) {
        lastError = error;
        await this.logEvolutionFailure({
          companyId,
          method,
          operation,
          fullUrl,
          data,
          params,
          error,
          responseTime: Date.now() - startedAt,
          attempt,
          attempts,
        });

        if (
          attempt >= attempts ||
          !this.shouldRetryEvolutionError(method, error)
        ) {
          break;
        }

        await this.sleep(300 * 2 ** (attempt - 1));
      }
    }

    throw lastError;
  }

  private normalizeRequestPath(path: string): string {
    return path.replace(/^\/+/, '');
  }

  private buildEvolutionUrl(
    path: string,
    params?: Record<string, string | number | boolean | undefined>,
  ): string {
    if (!this.evolutionApiUrl) {
      throw new BadRequestException('EVOLUTION_API_URL nao configurada no servidor');
    }

    const url = new URL(path, `${this.evolutionApiUrl}/`);

    for (const [key, value] of Object.entries(params || {})) {
      if (value === undefined || value === null) {
        continue;
      }

      url.searchParams.set(key, String(value));
    }

    return url.toString();
  }

  private shouldRetryEvolutionError(
    method: EvolutionHttpMethod,
    error: unknown,
  ): boolean {
    if (method !== 'GET') {
      return false;
    }

    if (!axios.isAxiosError(error)) {
      return false;
    }

    if (!error.response) {
      return true;
    }

    return (
      error.response.status === 408 ||
      error.response.status === 429 ||
      error.response.status >= 500
    );
  }

  private shouldFallbackToFetchInstances(error: unknown): boolean {
    if (!axios.isAxiosError(error)) {
      return false;
    }

    const status = error.response?.status;

    if (!status) {
      return true;
    }

    return [404, 405, 500, 501, 502, 503, 504].includes(status);
  }

  private isAuthenticationError(error: unknown): boolean {
    const status = this.extractStatusCode(error);
    return status === 401 || status === 403;
  }

  private isInstanceAlreadyExistsError(error: unknown): boolean {
    const status = this.extractStatusCode(error);
    const message = this.extractAxiosMessage(error).toLowerCase();

    if (!status || ![400, 403, 409, 500].includes(status)) {
      return false;
    }

    return (
      message.includes('already exist') ||
      message.includes('instance exists') ||
      message.includes('ja existe')
    );
  }

  private extractStatusCode(error: unknown): number | null {
    return axios.isAxiosError(error) && error.response?.status
      ? error.response.status
      : null;
  }

  private extractAxiosMessage(error: unknown): string {
    if (!axios.isAxiosError(error)) {
      return error instanceof Error ? error.message : 'erro desconhecido';
    }

    const responseData = error.response?.data;
    if (typeof responseData === 'string' && responseData.trim()) {
      return responseData;
    }

    const responseRecord = this.asRecord(responseData);
    const message =
      this.asString(responseRecord?.message) ||
      this.asString(this.asRecord(responseRecord?.response)?.message);

    return message || error.message || 'erro desconhecido';
  }

  private async logEvolutionFailure(input: {
    companyId?: string;
    method: string;
    operation: string;
    fullUrl: string;
    data?: Record<string, unknown>;
    params?: Record<string, string | number | boolean | undefined>;
    error: unknown;
    responseTime: number;
    attempt: number;
    attempts: number;
  }): Promise<void> {
    const status = this.extractStatusCode(input.error);
    const responseData = axios.isAxiosError(input.error)
      ? input.error.response?.data
      : null;

    this.logger.error(
      JSON.stringify({
        event: 'evolution.request.failed',
        operation: input.operation,
        method: input.method,
        url: input.fullUrl,
        status,
        data: this.sanitizeForLogs(responseData),
        params: this.sanitizeForLogs(input.params),
        attempt: input.attempt,
        attempts: input.attempts,
      }),
      input.error instanceof Error ? input.error.stack : undefined,
    );

    await this.prisma.apiLog.create({
      data: {
        method: input.method,
        path: input.fullUrl,
        statusCode: status || 424,
        responseTime: input.responseTime,
        status: 'FAILED',
        provider: 'EVOLUTION',
        errorMessage: this.extractAxiosMessage(input.error),
        companyId: input.companyId || undefined,
        payload: {
          operation: input.operation,
          request: this.sanitizeForLogs(input.data),
          params: this.sanitizeForLogs(input.params),
          response: this.sanitizeForLogs(responseData),
          attempt: input.attempt,
          attempts: input.attempts,
        } as Prisma.InputJsonValue,
      },
    }).catch(() => undefined);
  }

  private sanitizeForLogs(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map((item) => this.sanitizeForLogs(item));
    }

    if (!value || typeof value !== 'object') {
      if (typeof value === 'string') {
        return this.redactSensitiveUrl(value);
      }
      return value;
    }

    const record = value as Record<string, unknown>;

    return Object.fromEntries(
      Object.entries(record).map(([key, entryValue]) => {
        const normalizedKey = key.toLowerCase();
        if (
          normalizedKey.includes('apikey') ||
          normalizedKey.includes('authorization') ||
          normalizedKey.includes('token') ||
          normalizedKey.includes('password')
        ) {
          return [key, '<redacted>'];
        }

        if (normalizedKey === 'url' && typeof entryValue === 'string') {
          return [key, this.redactSensitiveUrl(entryValue)];
        }

        return [key, this.sanitizeForLogs(entryValue)];
      }),
    );
  }

  private redactSensitiveUrl(value: string): string {
    try {
      const url = new URL(value);

      for (const key of ['token', 'apikey', 'authorization']) {
        if (url.searchParams.has(key)) {
          url.searchParams.set(key, '<redacted>');
        }
      }

      return url.toString();
    } catch {
      return value;
    }
  }

  private readPositiveInteger(
    rawValue: string | undefined,
    fallback: number,
  ): number {
    const parsed = Number(rawValue);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
  }

  private readBoundedInteger(
    rawValue: string | undefined,
    fallback: number,
    min: number,
    max: number,
  ): number {
    const parsed = this.readPositiveInteger(rawValue, fallback);
    return Math.min(max, Math.max(min, parsed));
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private isNotFoundError(error: unknown): boolean {
    const status = (error as AxiosError)?.response?.status;
    return status === 404;
  }

  private isUniqueConstraintError(error: unknown): boolean {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    );
  }

  private hashToken(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }

  private addDays(date: Date, days: number): Date {
    const clone = new Date(date);
    clone.setUTCDate(clone.getUTCDate() + days);
    return clone;
  }
}
