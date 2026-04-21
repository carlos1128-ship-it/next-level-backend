import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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

    const instanceName =
      dto.instanceName?.trim() || existing?.instanceName || this.buildInstanceName(companyId);
    const instanceToken = existing?.instanceToken || randomUUID();
    const webhookUrl = this.resolveN8nInboundWebhookUrl();

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

    await this.providerService.createInstance(companyId, connection.instanceName);
    const providerResult = await this.providerService.connectInstance(
      connection.instanceName,
    );

    if (providerResult.status === 'connected' && webhookUrl) {
      await this.providerService.setWebhook(
        connection.instanceName,
        webhookUrl,
        this.getWebhookEvents(),
        this.getAutomationHeaders(),
      );
    }

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
      const webhookUrl = this.resolveN8nInboundWebhookUrl();
      if (status === 'connected' && webhookUrl) {
        await this.providerService.setWebhook(
          connection.instanceName,
          webhookUrl,
          this.getWebhookEvents(),
          this.getAutomationHeaders(),
        ).catch(() => undefined);
      }
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
    const webhookUrl = this.resolveN8nInboundWebhookUrl();

    if (
      nextStatus === 'connected' &&
      webhookUrl &&
      connection.webhookUrl !== webhookUrl
    ) {
      await this.providerService.setWebhook(
        connection.instanceName,
        webhookUrl,
        this.getWebhookEvents(),
        this.getAutomationHeaders(),
      ).catch(() => undefined);
    }

    return this.prisma.whatsappConnection.update({
      where: { id: connection.id },
      data: {
        status: nextStatus,
        phoneNumber: remote.phoneNumber || connection.phoneNumber,
        qrCode: nextStatus === 'connected' ? null : connection.qrCode,
        pairingCode: nextStatus === 'connected' ? null : connection.pairingCode,
        webhookUrl: webhookUrl || connection.webhookUrl,
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
      webhookUrl: connection.webhookUrl,
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

  private resolveN8nInboundWebhookUrl() {
    return this.readString(
      this.configService.get<string>('N8N_INBOUND_WEBHOOK_URL'),
    );
  }

  private getWebhookEvents() {
    return [
      'QRCODE_UPDATED',
      'MESSAGES_UPSERT',
      'MESSAGES_UPDATE',
      'CONNECTION_UPDATE',
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

  private assertWebhookToken(expected: string | null, received?: string | null) {
    if (!expected || !received || expected !== received) {
      throw new UnauthorizedException('Token do webhook WhatsApp invalido');
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

  private readString(value: unknown) {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  }
}
