import {
  BadRequestException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../../prisma/prisma.service';
import { ConnectWhatsappDto } from '../dto/connect-whatsapp.dto';
import { WhatsappConversationsService } from './whatsapp-conversations.service';
import { WhatsappProviderEvolutionService } from './whatsapp-provider-evolution.service';

type EvolutionWebhookPayload = {
  event?: string;
  instance?: string;
  data?: {
    state?: string;
    qrcode?: { base64?: string };
    pairingCode?: string;
    code?: string;
    messages?: unknown[];
  };
};

@Injectable()
export class WhatsappConnectionsService {
  private readonly logger = new Logger(WhatsappConnectionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly providerService: WhatsappProviderEvolutionService,
    private readonly conversationsService: WhatsappConversationsService,
  ) {}

  async getCurrent(companyId: string) {
    const connection = await this.prisma.whatsappConnection.findUnique({
      where: { companyId },
    });

    if (!connection) {
      return this.buildSnapshot(null);
    }

    const current = await this.syncRemoteState(connection).catch(() => connection);
    return this.buildSnapshot(current);
  }

  async connect(companyId: string, dto: ConnectWhatsappDto) {
    await this.ensureCompany(companyId);

    const existing = await this.prisma.whatsappConnection.findUnique({
      where: { companyId },
    });

    const instanceName = await this.resolveInstanceName(companyId, dto, existing);
    const instanceToken = existing?.instanceToken || randomUUID();
    const webhookUrl = this.buildProviderWebhookUrl(instanceName, instanceToken);

    const connection = await this.prisma.whatsappConnection.upsert({
      where: { companyId },
      update: {
        provider: 'evolution',
        instanceName,
        instanceToken,
        webhookUrl,
        status: 'creating',
      },
      create: {
        companyId,
        provider: 'evolution',
        instanceName,
        instanceToken,
        webhookUrl,
        status: 'creating',
      },
    });

    await this.providerService.createInstance(companyId, connection.instanceName, {
      webhookUrl,
      events: this.getWebhookEvents(),
    });
    await this.ensureWebhookIfMissing(connection.instanceName, webhookUrl);

    const remoteState = await this.providerService
      .getInstanceState(connection.instanceName)
      .catch(() => null);

    if (remoteState?.state === 'open') {
      await this.providerService.restartInstance(connection.instanceName).catch((error) => {
        this.logger.warn(
          `Restart Evolution ignorado para ${connection.instanceName}: ${this.extractErrorMessage(error)}`,
        );
      });

      const updated = await this.prisma.whatsappConnection.update({
        where: { id: connection.id },
        data: {
          status: 'connected',
          qrCode: null,
          pairingCode: null,
          phoneNumber: remoteState.phoneNumber || connection.phoneNumber,
          webhookUrl,
          lastConnectionAt: connection.lastConnectionAt || new Date(),
        },
      });

      return this.buildSnapshot(updated);
    }

    const providerResult = await this.providerService.connectInstance(
      connection.instanceName,
    );

    const updated = await this.prisma.whatsappConnection.update({
      where: { id: connection.id },
      data: {
        status: providerResult.status,
        qrCode: providerResult.qrCode,
        pairingCode: providerResult.pairingCode,
        phoneNumber: providerResult.phoneNumber,
        webhookUrl,
        lastConnectionAt:
          providerResult.status === 'connected' ? new Date() : connection.lastConnectionAt,
      },
    });

    return this.buildSnapshot(updated);
  }

  async refreshQr(companyId: string) {
    const connection = await this.prisma.whatsappConnection.findUnique({
      where: { companyId },
    });

    if (!connection) {
      throw new BadRequestException('Nenhuma conexao WhatsApp encontrada para a empresa');
    }

    return this.connect(companyId, {
      instanceName: connection.instanceName,
    });
  }

  async restart(companyId: string) {
    const connection = await this.prisma.whatsappConnection.findUnique({
      where: { companyId },
    });

    if (!connection) {
      return this.connect(companyId, {});
    }

    return this.connect(companyId, {
      instanceName: connection.instanceName,
    });
  }

  async disconnect(companyId: string) {
    const connection = await this.prisma.whatsappConnection.findUnique({
      where: { companyId },
    });

    if (!connection) {
      return this.buildSnapshot(null);
    }

    if (this.providerService.isConfigured()) {
      await this.providerService.disconnectInstance(connection.instanceName).catch(() => undefined);
    }

    const updated = await this.prisma.whatsappConnection.update({
      where: { id: connection.id },
      data: {
        status: 'disconnected',
        qrCode: null,
        pairingCode: null,
        phoneNumber: null,
      },
    });

    return this.buildSnapshot(updated);
  }

  async handleEvolutionWebhook(
    payload: Record<string, unknown>,
    token?: string | null,
  ) {
    const event = this.readString(payload.event);
    const instanceName = this.readString(payload.instance);

    if (!event || !instanceName) {
      return;
    }

    const connection = await this.prisma.whatsappConnection.findUnique({
      where: { instanceName },
    });

    if (!connection) {
      return;
    }

    this.assertWebhookToken(connection.instanceToken, token);

    const data = (payload as EvolutionWebhookPayload).data || {};

    if (event === 'QRCODE_UPDATED') {
      const qrCode = this.normalizeQrCode(
        this.readString(data.qrcode?.base64) || this.readString(data.code),
      );

      await this.prisma.whatsappConnection.update({
        where: { id: connection.id },
        data: {
          status: qrCode ? 'waiting_qr' : 'creating',
          qrCode,
          pairingCode: this.readString(data.pairingCode),
        },
      });
      return;
    }

    if (event === 'CONNECTION_UPDATE') {
      const state = this.normalizeRemoteState(this.readString(data.state));
      const status = this.mapStateToStatus(state, connection.qrCode);
      const webhookUrl = this.buildProviderWebhookUrl(
        connection.instanceName,
        connection.instanceToken,
      );
      await this.prisma.whatsappConnection.update({
        where: { id: connection.id },
        data: {
          status,
          qrCode: state === 'open' ? null : connection.qrCode,
          pairingCode: state === 'open' ? null : connection.pairingCode,
          webhookUrl: webhookUrl || connection.webhookUrl,
          lastConnectionAt: state === 'open' ? new Date() : connection.lastConnectionAt,
        },
      });
      return;
    }

    if (event === 'MESSAGES_UPSERT' || event === 'MESSAGES_UPDATE') {
      const messages = Array.isArray(data.messages) ? data.messages : [];
      await this.conversationsService.ingestEvolutionMessages(connection, messages);
      await this.forwardAutomationEvent(connection, payload).catch((error) => {
        this.logger.warn(
          `Falha ao encaminhar mensagem WhatsApp ao n8n para ${connection.instanceName}: ${
            error instanceof Error ? error.message : 'erro desconhecido'
          }`,
        );
      });
    }
  }

  async findByInstanceName(instanceName: string) {
    return this.prisma.whatsappConnection.findUnique({
      where: { instanceName },
      include: {
        company: {
          select: {
            id: true,
            name: true,
            sector: true,
            segment: true,
            timezone: true,
          },
        },
      },
    });
  }

  private async syncRemoteState(connection: {
    id: string;
    status: string;
    qrCode: string | null;
    pairingCode: string | null;
    phoneNumber: string | null;
    lastConnectionAt: Date | null;
    updatedAt: Date;
    createdAt: Date;
    companyId: string;
    provider: string;
    instanceName: string;
    instanceToken: string | null;
    webhookUrl: string | null;
  }) {
    if (!this.providerService.isConfigured()) {
      return connection;
    }

    const remote = await this.providerService.getInstanceState(connection.instanceName);
    const nextStatus = this.mapStateToStatus(remote.state, connection.qrCode);

    return this.prisma.whatsappConnection.update({
      where: { id: connection.id },
      data: {
        status: nextStatus,
        phoneNumber: remote.phoneNumber || connection.phoneNumber,
        qrCode: nextStatus === 'connected' ? null : connection.qrCode,
        pairingCode: nextStatus === 'connected' ? null : connection.pairingCode,
        webhookUrl: connection.webhookUrl,
        lastConnectionAt:
          nextStatus === 'connected' ? connection.lastConnectionAt || new Date() : connection.lastConnectionAt,
      },
    });
  }

  private buildSnapshot(connection: {
    id: string;
    companyId: string;
    provider: string;
    instanceName: string;
    status: string;
    qrCode: string | null;
    pairingCode: string | null;
    phoneNumber: string | null;
    webhookUrl: string | null;
    lastConnectionAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  } | null) {
    if (!connection) {
      return {
        id: null,
        companyId: null,
        provider: 'evolution',
        instanceName: null,
        status: 'disconnected',
        qrCode: null,
        pairingCode: null,
        phoneNumber: null,
        webhookUrl: null,
        webhookStatus: 'pending',
        automationStatus: this.resolveAutomationStatus(),
        lastConnectionAt: null,
        createdAt: null,
        updatedAt: null,
      };
    }

    return {
      id: connection.id,
      companyId: connection.companyId,
      provider: connection.provider,
      instanceName: connection.instanceName,
      status: connection.status,
      qrCode: connection.qrCode,
      pairingCode: connection.pairingCode,
      phoneNumber: connection.phoneNumber,
      webhookUrl: this.redactSensitiveUrl(connection.webhookUrl),
      webhookStatus: connection.webhookUrl ? 'configured' : 'pending',
      automationStatus: this.resolveAutomationStatus(),
      lastConnectionAt: connection.lastConnectionAt?.toISOString() || null,
      createdAt: connection.createdAt.toISOString(),
      updatedAt: connection.updatedAt.toISOString(),
    };
  }

  private async ensureCompany(companyId: string) {
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { id: true },
    });

    if (!company) {
      throw new BadRequestException('Empresa invalida');
    }
  }

  private buildInstanceName(companyId: string) {
    return `nextlevel-${companyId}`;
  }

  private async resolveInstanceName(
    companyId: string,
    dto: ConnectWhatsappDto,
    existing: { instanceName: string } | null,
  ) {
    const requested = this.readString(dto.instanceName);
    if (requested) {
      return requested;
    }

    if (existing?.instanceName) {
      return existing.instanceName;
    }

    const legacy = await this.prisma.whatsappInstance.findUnique({
      where: { companyId },
      select: { instanceName: true },
    });

    return legacy?.instanceName || this.buildInstanceName(companyId);
  }

  private resolveN8nInboundWebhookUrl() {
    return this.readString(
      this.configService.get<string>('N8N_WEBHOOK_URL') ||
        this.configService.get<string>('N8N_INBOUND_WEBHOOK_URL'),
    );
  }

  private buildProviderWebhookUrl(instanceName: string, token: string | null) {
    if (!token) {
      throw new BadRequestException('Token do webhook WhatsApp nao configurado');
    }

    const backendUrl = this.readString(
      this.configService.get<string>('BACKEND_URL') ||
        this.configService.get<string>('APP_URL') ||
        this.configService.get<string>('PUBLIC_API_URL'),
    );

    if (!backendUrl) {
      throw new BadRequestException('BACKEND_URL precisa estar configurada para webhooks da Evolution');
    }

    const url = new URL('api/whatsapp/webhooks/evolution', `${backendUrl.replace(/\/+$/, '')}/`);
    url.searchParams.set('instance', instanceName);
    url.searchParams.set('token', token);
    return url.toString();
  }

  private async configureProviderWebhook(instanceName: string, webhookUrl: string) {
    await this.providerService.setWebhook(
      instanceName,
      webhookUrl,
      this.getWebhookEvents(),
    );

    const verified = await this.providerService.verifyWebhook(instanceName, webhookUrl);
    if (!verified) {
      this.logger.warn(
        `Webhook Evolution configurado para ${instanceName}, mas a verificacao remota nao confirmou a URL esperada.`,
      );
    }
  }

  private async ensureWebhookIfMissing(instanceName: string, webhookUrl: string) {
    let currentWebhook: unknown = null;

    try {
      currentWebhook = await this.providerService.getWebhook(instanceName);
    } catch (error) {
      this.logger.warn(
        `Nao foi possivel consultar webhook Evolution para ${instanceName}; tentando provisionar uma vez: ${this.extractErrorMessage(error)}`,
      );
    }

    const current = this.extractWebhookState(currentWebhook);
    if (current.enabled && current.url === webhookUrl) {
      return;
    }

    try {
      await this.configureProviderWebhook(instanceName, webhookUrl);
    } catch (error) {
      if (this.isInstanceRequiresWebhookError(error)) {
        this.logger.warn(
          `Evolution recusou webhook/set para ${instanceName} porque a instancia exige webhook no create; seguindo sem bloquear QR.`,
        );
        return;
      }

      throw error;
    }
  }

  private getWebhookEvents() {
    return [
      'QRCODE_UPDATED',
      'MESSAGES_UPSERT',
      'MESSAGES_UPDATE',
      'CONNECTION_UPDATE',
      'SEND_MESSAGE',
    ];
  }

  private getAutomationHeaders() {
    const token = this.readString(
      this.configService.get<string>('INTERNAL_AUTOMATION_TOKEN'),
    );

    return token
      ? {
          Authorization: `Bearer ${token}`,
          'x-internal-automation-token': token,
        }
      : undefined;
  }

  private resolveAutomationStatus() {
    return this.resolveN8nInboundWebhookUrl() && this.getAutomationHeaders()
      ? 'configured'
      : 'pending';
  }

  private async forwardAutomationEvent(
    connection: {
      id: string;
      companyId: string;
      instanceName: string;
      status: string;
    },
    payload: Record<string, unknown>,
  ) {
    const webhookUrl = this.resolveN8nInboundWebhookUrl();
    const headers = this.getAutomationHeaders();

    if (!webhookUrl || !headers) {
      this.logger.warn(
        `Automacao n8n nao configurada; evento de mensagem preservado apenas no backend para ${connection.instanceName}.`,
      );
      return;
    }

    await axios.post(
      webhookUrl,
      this.buildAutomationPayload(connection, payload),
      {
        timeout: 10000,
        headers,
      },
    );
  }

  private buildAutomationPayload(
    connection: {
      id: string;
      companyId: string;
      instanceName: string;
      status: string;
    },
    payload: Record<string, unknown>,
  ) {
    const data = this.asRecord(payload.data) || {};
    const messages = Array.isArray(data.messages) ? data.messages : [];
    const firstMessage = this.asRecord(messages[0]);
    const normalizedData = firstMessage || data;
    const normalizedEvent = this.normalizeAutomationEventName(
      this.readString(payload.event),
    );

    return {
      ...payload,
      event: normalizedEvent,
      data: normalizedData,
      rawEvolutionPayload: payload,
      instanceName: this.readString(payload.instanceName) || connection.instanceName,
      instance: this.readString(payload.instance) || connection.instanceName,
      companyId: connection.companyId,
      whatsappConnectionId: connection.id,
      connectionStatus: connection.status,
      source: 'next-level-backend',
    };
  }

  private normalizeAutomationEventName(event: string | null) {
    if (event === 'MESSAGES_UPSERT') {
      return 'messages.upsert';
    }

    if (event === 'MESSAGES_UPDATE') {
      return 'messages.update';
    }

    return event || 'unknown';
  }

  private asRecord(value: unknown) {
    return value && typeof value === 'object'
      ? (value as Record<string, unknown>)
      : null;
  }

  private assertWebhookToken(expected: string | null, received?: string | null) {
    if (!expected || !received || expected !== received) {
      throw new UnauthorizedException('Token do webhook WhatsApp invalido');
    }
  }

  private redactSensitiveUrl(value: string | null) {
    if (!value) {
      return null;
    }

    try {
      const url = new URL(value);
      if (url.searchParams.has('token')) {
        url.searchParams.set('token', '<redacted>');
      }
      return url.toString();
    } catch {
      return value;
    }
  }

  private normalizeQrCode(value: string | null) {
    if (!value) {
      return null;
    }

    if (value.startsWith('data:')) {
      return value;
    }

    if (/^[A-Za-z0-9+/=]+$/.test(value) && value.length > 100) {
      return `data:image/png;base64,${value}`;
    }

    return value;
  }

  private normalizeRemoteState(value: string | null) {
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

  private mapStateToStatus(state: string, qrCode: string | null) {
    if (state === 'open') {
      return 'connected';
    }

    if (qrCode || state === 'connecting') {
      return 'waiting_qr';
    }

    if (state === 'close') {
      return 'disconnected';
    }

    return 'error';
  }

  private extractWebhookState(payload: unknown) {
    const root = this.asRecord(payload);
    const webhook = this.asRecord(root?.webhook) || root;
    const nested = this.asRecord(webhook?.webhook);
    const rawEnabled = webhook?.enabled ?? nested?.enabled;

    return {
      url:
        this.readString(webhook?.url) ||
        this.readString(nested?.url),
      enabled:
        rawEnabled === true ||
        this.readString(rawEnabled)?.toLowerCase() === 'true',
    };
  }

  private isInstanceRequiresWebhookError(error: unknown) {
    const statusCode =
      error instanceof BadRequestException ? error.getStatus() : null;
    const message = this.extractErrorMessage(error).toLowerCase();
    return (
      statusCode === 400 &&
      message.includes('instance') &&
      message.includes('requires') &&
      message.includes('webhook')
    );
  }

  private extractErrorMessage(error: unknown) {
    if (error instanceof BadRequestException) {
      const response = error.getResponse();
      if (typeof response === 'string') return response;
      const record = this.asRecord(response);
      return this.readString(record?.message) || error.message;
    }

    return error instanceof Error ? error.message : 'erro desconhecido';
  }

  private readString(value: unknown) {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  }
}
