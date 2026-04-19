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

@Injectable()
export class EvolutionService {
  private readonly logger = new Logger(EvolutionService.name);
  private readonly api: AxiosInstance;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly eventEmitter: EventEmitter2,
    private readonly platformQueue: PlatformQueueService,
  ) {
    this.api = axios.create({
      baseURL: this.configService.get<string>('EVOLUTION_API_URL'),
      headers: {
        apikey: this.configService.get<string>('EVOLUTION_API_KEY'),
        'Content-Type': 'application/json',
      },
      timeout: 30000,
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

    const response = await this.api.post(`/message/sendText/${instance.instanceName}`, {
      number,
      text: trimmedText,
      delay: 0,
      linkPreview: false,
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

    return response.data;
  }

  async disconnectInstance(companyId: string): Promise<void> {
    this.ensureConfigured();

    const instance = await this.prisma.whatsappInstance.findUnique({
      where: { companyId },
    });

    if (!instance) {
      return;
    }

    await this.api.delete(`/instance/logout/${instance.instanceName}`).catch(() => undefined);
    await this.api.delete(`/instance/delete/${instance.instanceName}`).catch(() => undefined);

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
    const exists = await this.remoteInstanceExists(instance.instanceName);
    if (exists) {
      return;
    }

    const webhookToken = this.deriveWebhookToken(instance.instanceName);
    const webhookUrl = this.buildWebhookUrl(instance.instanceName, webhookToken);

    await this.api.post('/instance/create', {
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
    });

    await this.prisma.whatsappInstance.update({
      where: { id: instance.id },
      data: {
        status: WhatsappInstanceStatus.CONNECTING,
        connectionState: 'connecting',
        lastError: null,
      },
    }).catch(() => undefined);
  }

  private async configureWebhook(instance: WhatsappInstance) {
    const webhookToken = this.deriveWebhookToken(instance.instanceName);
    const webhookUrl = this.buildWebhookUrl(instance.instanceName, webhookToken);

    await this.api.post(`/webhook/set/${instance.instanceName}`, {
      enabled: true,
      url: webhookUrl,
      webhookByEvents: false,
      webhookBase64: true,
      events: WEBHOOK_EVENTS,
    });
  }

  private async requestConnection(instance: WhatsappInstance) {
    const response = await this.api.get(`/instance/connect/${instance.instanceName}`);
    const pairingCode = this.asString(response.data?.pairingCode);
    const qrCode = this.normalizeQrCode(this.asString(response.data?.code));

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
    try {
      await this.api.get(`/instance/connectionState/${instanceName}`);
      return true;
    } catch (error) {
      if (this.isNotFoundError(error)) {
        return false;
      }
      throw error;
    }
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
    return `${this.getBackendUrl()}/api/evolution/webhook?instance=${encodeURIComponent(
      instanceName,
    )}&token=${encodeURIComponent(token)}`;
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
      if (!this.asString(this.configService.get<string>('EVOLUTION_API_URL'))) {
        throw new BadRequestException('EVOLUTION_API_URL nao configurada no servidor');
      }

      throw new BadRequestException('EVOLUTION_API_KEY nao configurada no servidor');
    }
  }

  private isConfigured(): boolean {
    if (!this.asString(this.configService.get<string>('EVOLUTION_API_URL'))) {
      return false;
    }

    if (!this.asString(this.configService.get<string>('EVOLUTION_API_KEY'))) {
      return false;
    }

    return true;
  }

  private async syncRemoteState(instance: WhatsappInstance): Promise<WhatsappInstance> {
    if (!this.isConfigured()) {
      return instance;
    }

    try {
      const response = await this.api.get(`/instance/connectionState/${instance.instanceName}`);
      const state = this.asString(response.data?.instance?.state) || 'close';
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
    } catch (error) {
      if (this.isNotFoundError(error)) {
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
            },
          }),
        ]);

        return updated;
      }

      this.logger.warn(
        `Falha ao sincronizar estado remoto da Evolution para ${instance.companyId}: ${
          (error as Error)?.message || 'erro desconhecido'
        }`,
      );
      return instance;
    }
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
