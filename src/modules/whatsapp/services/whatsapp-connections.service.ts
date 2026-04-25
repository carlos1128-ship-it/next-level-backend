import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@prisma/client';
import axios from 'axios';
import { createHash, randomUUID } from 'crypto';
import { PrismaService } from '../../../prisma/prisma.service';
import { ConnectWhatsappDto } from '../dto/connect-whatsapp.dto';
import { WhatsappConversationsService } from './whatsapp-conversations.service';
import { WhatsappProviderEvolutionService } from './whatsapp-provider-evolution.service';

const OPERATION_LOCK_TTL_MS = 45000;
const WEBHOOK_RECONFIGURE_COOLDOWN_MS = 60000;
const REMOTE_SYNC_COOLDOWN_MS = 8000;
const CONNECT_START_COOLDOWN_MS = 10000;
const QR_REQUEST_COOLDOWN_MS = 15000;
const REPAIR_COOLDOWN_MS = 30000;
const RATE_LIMIT_COOLDOWN_MS = 60000;
const TIMEOUT_COOLDOWN_MS = 20000;
const DISCONNECT_ACTION_COOLDOWN_MS = 60000;
const INSTANCE_CYCLE_COOLDOWN_MS = 120000;
const CONNECTED_LOCAL_TRUST_MS = 300000;
const LEGACY_SHARED_INSTANCE_NAMES = new Set(['next-text', 'next-test']);

type EvolutionWebhookPayload = {
  event?: string;
  instance?: string;
  data?: {
    state?: string;
    qrcode?: { base64?: string; code?: string } | string;
    pairingCode?: string;
    code?: string;
    phone?: string;
    number?: string;
    ownerJid?: string;
    messages?: unknown[];
  };
};

type ConnectionRecord = {
  id: string;
  companyId: string;
  provider: string;
  instanceName: string;
  instanceId: string | null;
  instanceToken: string | null;
  status: string;
  connectionState: string;
  qrCode: string | null;
  qrCodeText: string | null;
  pairingCode: string | null;
  phoneNumber: string | null;
  webhookUrl: string | null;
  webhookEnabled: boolean;
  webhookLastConfiguredAt: Date | null;
  webhookLastError: string | null;
  webhookConfigHash: string | null;
  userRequestedDisconnect: boolean;
  sessionGeneration: number;
  lastEvolutionState: string | null;
  lastConnectionEventAt: Date | null;
  lastQrAt: Date | null;
  lastQrGeneratedAt: Date | null;
  lastError: string | null;
  lastConnectionAt: Date | null;
  lastConnectedAt: Date | null;
  lastDisconnectedAt: Date | null;
  lastEvolutionSyncAt: Date | null;
  lastConnectStartAt: Date | null;
  lastQrRequestAt: Date | null;
  lastRepairAt: Date | null;
  providerRetryAfterUntil: Date | null;
  operationLockUntil: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

@Injectable()
export class WhatsappConnectionsService {
  private readonly logger = new Logger(WhatsappConnectionsService.name);
  private readonly operationLocks = new Map<string, string>();
  private readonly providerActionCooldowns = new Map<string, number>();

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

    return this.buildSnapshot(connection);
  }

  async connect(companyId: string, dto: ConnectWhatsappDto) {
    return this.withOperationLock(companyId, () => this.connectUnlocked(companyId, dto));
  }

  async refreshQr(companyId: string) {
    const connection = await this.prisma.whatsappConnection.findUnique({
      where: { companyId },
    });

    if (!connection) {
      throw new BadRequestException('Nenhuma conexao WhatsApp encontrada para a empresa');
    }

    return this.requestQr(companyId);
  }

  async requestQr(companyId: string) {
    return this.withOperationLock(companyId, async () => {
      const connection = await this.prisma.whatsappConnection.findUnique({
        where: { companyId },
      });

      if (!connection) {
        throw new BadRequestException('Prepare a conexao WhatsApp antes de pedir o QR Code');
      }

      return this.requestQrForConnection(connection);
    });
  }

  async restart(companyId: string) {
    return this.withOperationLock(companyId, async () => {
      const connection = await this.prisma.whatsappConnection.findUnique({
        where: { companyId },
      });

      if (!connection) {
        return this.buildSnapshot(null);
      }

      const cooldown = this.getCooldownSeconds(connection.lastRepairAt, REPAIR_COOLDOWN_MS);
      if (cooldown > 0) {
        this.logWhatsappEvent('whatsapp.connect.start.skip_due_cooldown', {
          companyId,
          instanceName: connection.instanceName,
          retryAfterSeconds: cooldown,
        });
        return this.buildSnapshot(connection, cooldown);
      }

      const events = this.getWebhookEvents();
      const configHash = connection.webhookUrl
        ? this.hashWebhookConfig(connection.webhookUrl, events)
        : null;
      const staleWebhook =
        Boolean(connection.webhookUrl) &&
        (!connection.webhookEnabled ||
          connection.webhookConfigHash !== configHash ||
          Boolean(connection.webhookLastError));

      if (staleWebhook && connection.webhookUrl) {
        await this.ensureWebhookIfMissing(connection.instanceName, connection.webhookUrl).catch((error) => {
          this.logger.warn(
            `Reparo nao conseguiu reconfigurar webhook para ${connection.instanceName}: ${this.extractErrorMessage(error)}`,
          );
        });
      }

      const updated = await this.prisma.whatsappConnection.update({
        where: { id: connection.id },
        data: {
          status: connection.status === 'connected' ? 'connected' : 'repair_ready',
          lastRepairAt: new Date(),
          qrCode: connection.status === 'connected' ? null : connection.qrCode,
          qrCodeText: connection.status === 'connected' ? null : connection.qrCodeText,
          pairingCode: connection.status === 'connected' ? null : connection.pairingCode,
          lastError:
            connection.status === 'connected'
              ? null
              : 'Reparo preparado. Clique em Conectar WhatsApp para gerar um novo QR Code.',
        },
      });
      this.logWhatsappEvent('whatsapp.repair.ready', {
        companyId,
        instanceName: connection.instanceName,
      });
      return this.buildSnapshot(updated);
    });
  }

  async disconnect(companyId: string) {
    return this.withOperationLock(companyId, async () => {
      const connection = await this.prisma.whatsappConnection.findUnique({
        where: { companyId },
      });

      if (!connection) {
        return this.buildSnapshot(null);
      }

      await this.prisma.whatsappConnection.update({
        where: { id: connection.id },
        data: {
          status: 'disconnecting',
          userRequestedDisconnect: true,
          qrCode: null,
          qrCodeText: null,
          pairingCode: null,
          lastError: null,
        },
      });
      this.logWhatsappEvent('whatsapp.disconnect.local_marked', {
        companyId,
        instanceName: connection.instanceName,
      });

      if (this.providerService.isConfigured()) {
        try {
          this.assertProviderActionAllowed(connection.instanceName, 'disconnect', DISCONNECT_ACTION_COOLDOWN_MS);
          await this.providerService.logoutInstance(connection.instanceName);
          this.assertProviderActionAllowed(connection.instanceName, 'delete', INSTANCE_CYCLE_COOLDOWN_MS);
          await this.providerService.deleteInstance(connection.instanceName);
        } catch (error) {
          const message = this.buildProviderUserMessage(error);
          const status = this.isProviderRateLimitError(error)
            ? 'disconnect_pending'
            : 'disconnected_pending_provider_cleanup';
          const updated = await this.prisma.whatsappConnection.update({
            where: { id: connection.id },
            data: {
              status,
              userRequestedDisconnect: true,
              qrCode: null,
              qrCodeText: null,
              pairingCode: null,
              phoneNumber: null,
              connectionState: 'close',
              lastEvolutionState: 'close',
              lastConnectionEventAt: new Date(),
              lastDisconnectedAt: new Date(),
              lastError: message,
              providerRetryAfterUntil: this.resolveProviderRetryAfterUntil(error),
            },
          });
          this.logWhatsappEvent('whatsapp.disconnect.provider_failed', {
            companyId,
            instanceName: connection.instanceName,
            status,
            message,
          });
          this.logger.warn(
            `Falha ao limpar sessao Evolution para ${connection.instanceName}: ${this.extractErrorMessage(error)}`,
          );
          return this.buildSnapshot(updated);
        }
      }

      const updated = await this.prisma.whatsappConnection.update({
        where: { id: connection.id },
        data: {
          status: 'disconnected',
          userRequestedDisconnect: true,
          qrCode: null,
          qrCodeText: null,
          pairingCode: null,
          phoneNumber: null,
          webhookEnabled: false,
          webhookLastError: null,
          connectionState: 'close',
          lastEvolutionState: 'close',
          lastConnectionEventAt: new Date(),
          lastDisconnectedAt: new Date(),
          lastError: null,
        },
      });

      this.logWhatsappEvent('whatsapp.disconnect.done', {
        companyId,
        instanceName: connection.instanceName,
      });
      return this.buildSnapshot(updated);
    });
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
    await this.saveWebhookEvent(connection.companyId, payload);

    const data = (payload as EvolutionWebhookPayload).data || {};

    if (event === 'QRCODE_UPDATED') {
      if (connection.userRequestedDisconnect) {
        this.logger.warn(
          `QR Evolution ignorado para ${connection.instanceName}; disconnect solicitado pelo usuario.`,
        );
        return;
      }

      if (!['creating_instance', 'qr_required', 'qr_pending', 'connecting'].includes(connection.status)) {
        this.logger.warn(
          `QR Evolution ignorado para ${connection.instanceName}; status local ${connection.status} nao espera QR.`,
        );
        return;
      }

      const qrcodeRecord = this.asRecord(data.qrcode);
      const qrCode = this.normalizeQrCode(
        this.readString(qrcodeRecord?.base64) ||
          this.readString(qrcodeRecord?.code) ||
          this.readString(data.code) ||
          this.readString(data.qrcode),
      );
      const qrCodeText =
        this.readString(qrcodeRecord?.code) ||
        this.readString(data.code) ||
        this.readString(data.qrcode);
      const pairingCode = this.readString(data.pairingCode);
      const hasQrSignal = Boolean(qrCode || pairingCode);

      await this.prisma.whatsappConnection.update({
        where: { id: connection.id },
        data: {
          status: hasQrSignal ? 'qr_pending' : 'creating_instance',
          connectionState: 'connecting',
          qrCode,
          qrCodeText,
          pairingCode,
          lastQrAt: hasQrSignal ? new Date() : connection.lastQrAt,
          lastQrGeneratedAt: hasQrSignal ? new Date() : connection.lastQrGeneratedAt,
          lastConnectionEventAt: new Date(),
          lastError: null,
        },
      });
      return;
    }

    if (event === 'CONNECTION_UPDATE') {
      const state = this.normalizeRemoteState(this.readString(data.state));
      if (
        state === connection.lastEvolutionState &&
        connection.lastConnectionEventAt &&
        Date.now() - connection.lastConnectionEventAt.getTime() < 5000
      ) {
        return;
      }

      const phoneNumber = this.normalizePhone(
        this.readString(data.phone) ||
          this.readString(data.number) ||
          this.readString(data.ownerJid),
      );
      const nextStatus = this.resolveWebhookStatus(connection, state);

      await this.prisma.whatsappConnection.update({
        where: { id: connection.id },
        data: {
          status: nextStatus,
          connectionState: state,
          qrCode: state === 'open' ? null : connection.qrCode,
          qrCodeText: state === 'open' ? null : connection.qrCodeText,
          pairingCode: state === 'open' ? null : connection.pairingCode,
          phoneNumber: state === 'open' ? phoneNumber || connection.phoneNumber : connection.phoneNumber,
          userRequestedDisconnect:
            state === 'open' && !connection.userRequestedDisconnect ? false : connection.userRequestedDisconnect,
          lastEvolutionState: state,
          lastConnectionEventAt: new Date(),
          lastConnectionAt:
            state === 'open' ? connection.lastConnectionAt || new Date() : connection.lastConnectionAt,
          lastConnectedAt:
            state === 'open' && !connection.userRequestedDisconnect
              ? connection.lastConnectedAt || new Date()
              : connection.lastConnectedAt,
          lastDisconnectedAt:
            state === 'close' ? new Date() : connection.lastDisconnectedAt,
          lastError:
            connection.userRequestedDisconnect && state === 'open'
              ? 'Evolution ainda informou open apos disconnect solicitado'
              : null,
        },
      });
      return;
    }

    if (event === 'MESSAGES_UPSERT' || event === 'MESSAGES_UPDATE') {
      const messages = Array.isArray(data.messages) ? data.messages : [];
      await this.conversationsService.ingestEvolutionMessages(connection, messages);

      if (
        event === 'MESSAGES_UPSERT' &&
        connection.status === 'connected' &&
        (await this.isAutomationEnabled(connection.companyId))
      ) {
        void this.forwardAutomationEvent(connection, payload).catch((error) => {
          this.logger.warn(
            `Falha ao encaminhar mensagem WhatsApp ao n8n para ${connection.instanceName}: ${
              error instanceof Error ? error.message : 'erro desconhecido'
            }`,
          );
        });
      }
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

  private async connectUnlocked(companyId: string, dto: ConnectWhatsappDto) {
    await this.ensureCompany(companyId);
    this.logWhatsappEvent('whatsapp.connect.start.begin', { companyId });

    const existing = await this.prisma.whatsappConnection.findUnique({
      where: { companyId },
    });

    this.logWhatsappEvent('whatsapp.connect.start.local_state', {
      companyId,
      status: existing?.status || 'not_configured',
      instanceName: existing?.instanceName || null,
    });

    const providerCooldown = this.getProviderRetryAfterSeconds(existing);
    if (existing && providerCooldown > 0) {
      this.logWhatsappEvent('whatsapp.connect.start.skip_due_cooldown', {
        companyId,
        instanceName: existing.instanceName,
        retryAfterSeconds: providerCooldown,
      });
      return this.buildSnapshot(existing, providerCooldown);
    }

    const startCooldown = this.getCooldownSeconds(existing?.lastConnectStartAt, CONNECT_START_COOLDOWN_MS);
    if (existing && startCooldown > 0) {
      this.logWhatsappEvent('whatsapp.connect.start.skip_due_cooldown', {
        companyId,
        instanceName: existing.instanceName,
        retryAfterSeconds: startCooldown,
      });
      return this.buildSnapshot(existing, startCooldown);
    }

    if (existing?.status === 'connected' && !existing.userRequestedDisconnect) {
      const trustedAt =
        existing.lastConnectionEventAt ||
        existing.lastConnectedAt ||
        existing.updatedAt;
      if (Date.now() - trustedAt.getTime() < CONNECTED_LOCAL_TRUST_MS) {
        this.logWhatsappEvent('whatsapp.connect.connected', {
          companyId,
          instanceName: existing.instanceName,
          source: 'local_db',
        });
        return this.buildSnapshot(existing);
      }
    }

    const sessionGeneration = this.resolveNextSessionGeneration(existing);
    const instanceName = await this.resolveInstanceName(companyId, dto, existing, sessionGeneration);
    const instanceToken = this.shouldRotateInstance(existing, instanceName)
      ? randomUUID()
      : existing?.instanceToken || randomUUID();
    const webhookUrl = this.buildProviderWebhookUrl(instanceName, instanceToken);
    this.logWhatsappEvent('whatsapp.connect.instance.selected', {
      companyId,
      instanceName,
      sessionGeneration,
      reusedLocalRecord: Boolean(existing && existing.instanceName === instanceName),
    });

    const connection = await this.prisma.whatsappConnection.upsert({
      where: { companyId },
      update: {
        provider: 'evolution',
        instanceName,
        instanceToken,
        webhookUrl,
        status: 'creating_instance',
        connectionState: 'connecting',
        sessionGeneration,
        qrCode: null,
        qrCodeText: null,
        pairingCode: null,
        phoneNumber: null,
        userRequestedDisconnect: false,
        lastError: null,
      },
      create: {
        companyId,
        provider: 'evolution',
        instanceName,
        instanceToken,
        webhookUrl,
        status: 'creating_instance',
        connectionState: 'connecting',
        sessionGeneration,
      },
    });

    try {
      let webhookAlreadyProvisionedByCreate = false;
      if (!existing || existing.instanceName !== connection.instanceName) {
        this.assertProviderActionAllowed(connection.instanceName, 'create', INSTANCE_CYCLE_COOLDOWN_MS);
        const createResult = await this.providerService.createInstance(companyId, connection.instanceName, {
          webhookUrl,
          events: this.getWebhookEvents(),
        }) as { reused?: boolean };
        webhookAlreadyProvisionedByCreate = !createResult.reused;
        this.logWhatsappEvent(createResult.reused ? 'whatsapp.connect.instance.reused' : 'whatsapp.connect.instance.created', {
          companyId,
          instanceName: connection.instanceName,
        });
      } else {
        this.logWhatsappEvent('whatsapp.connect.instance.reused', {
          companyId,
          instanceName: connection.instanceName,
          source: 'local_db',
        });
      }

      if (webhookAlreadyProvisionedByCreate) {
        await this.prisma.whatsappConnection.update({
          where: { id: connection.id },
          data: {
            webhookUrl,
            webhookEnabled: true,
            webhookLastConfiguredAt: new Date(),
            webhookLastError: null,
            webhookConfigHash: this.hashWebhookConfig(webhookUrl, this.getWebhookEvents()),
          },
        });
      } else {
        await this.ensureWebhookIfMissing(connection.instanceName, webhookUrl);
      }

      const prepared = await this.prisma.whatsappConnection.update({
        where: { id: connection.id },
        data: { lastConnectStartAt: new Date() },
      });
      this.logWhatsappEvent('whatsapp.connect.start.prepare_done', {
        companyId,
        instanceName: connection.instanceName,
      });
      return this.requestQrForConnection(prepared);
    } catch (error) {
      const failureStatus = this.resolveProviderFailureStatus(error);
      const retryAfterUntil = this.resolveProviderRetryAfterUntil(error);
      this.logWhatsappEvent(this.isProviderRateLimitError(error) ? 'whatsapp.qr.request.rate_limited' : 'whatsapp.qr.request.timeout', {
        companyId,
        instanceName: connection.instanceName,
        message: this.buildProviderUserMessage(error),
      });
      const updated = await this.prisma.whatsappConnection.update({
        where: { id: connection.id },
        data: {
          status: failureStatus,
          connectionState: 'close',
          lastError: this.buildProviderUserMessage(error),
          providerRetryAfterUntil: retryAfterUntil,
          lastConnectStartAt: new Date(),
        },
      });
      return this.buildSnapshot(updated);
    }
  }

  private async requestQrForConnection(connection: ConnectionRecord) {
    try {
      if (connection.status === 'connected' && !connection.userRequestedDisconnect) {
        this.logWhatsappEvent('whatsapp.connect.connected', {
          companyId: connection.companyId,
          instanceName: connection.instanceName,
          source: 'local_db',
        });
        return this.buildSnapshot(connection);
      }

      const providerCooldown = this.getProviderRetryAfterSeconds(connection);
      if (providerCooldown > 0) {
        this.logWhatsappEvent('whatsapp.connect.start.skip_due_cooldown', {
          companyId: connection.companyId,
          instanceName: connection.instanceName,
          retryAfterSeconds: providerCooldown,
        });
        return this.buildSnapshot(connection, providerCooldown);
      }

      const qrCooldown = this.getCooldownSeconds(connection.lastQrRequestAt, QR_REQUEST_COOLDOWN_MS);
      if (qrCooldown > 0) {
        this.logWhatsappEvent('whatsapp.connect.start.skip_due_cooldown', {
          companyId: connection.companyId,
          instanceName: connection.instanceName,
          retryAfterSeconds: qrCooldown,
        });
        return this.buildSnapshot(connection, qrCooldown);
      }

      this.assertProviderActionAllowed(connection.instanceName, 'connect', QR_REQUEST_COOLDOWN_MS);
      this.logWhatsappEvent('whatsapp.qr.request.begin', {
        companyId: connection.companyId,
        instanceName: connection.instanceName,
      });
      const providerResult = await this.providerService.connectInstance(
        connection.instanceName,
      );
      const now = new Date();
      const qrCode = providerResult.qrCode || providerResult.code || null;
      const qrCodeText = providerResult.code || null;
      const hasQrSignal = Boolean(qrCode || providerResult.pairingCode);
      const nextStatus =
        providerResult.status === 'connected'
          ? 'connected'
          : hasQrSignal
            ? 'qr_pending'
            : providerResult.status === 'qr_not_ready'
              ? 'qr_not_ready'
              : 'provider_warming_up';
      this.logWhatsappEvent(
        providerResult.status === 'connected'
          ? 'whatsapp.connect.connected'
          : hasQrSignal
            ? 'whatsapp.qr.request.success'
            : 'whatsapp.qr.request.no_qr',
        {
          companyId: connection.companyId,
          instanceName: connection.instanceName,
          providerStatus: providerResult.status,
        },
      );
      const updated = await this.prisma.whatsappConnection.update({
        where: { id: connection.id },
        data: {
          status: nextStatus,
          connectionState:
            providerResult.status === 'connected' ? 'open' : 'connecting',
          qrCode,
          qrCodeText,
          pairingCode: providerResult.pairingCode,
          phoneNumber: providerResult.phoneNumber || connection.phoneNumber,
          userRequestedDisconnect: false,
          lastEvolutionState:
            providerResult.status === 'connected' ? 'open' : connection.lastEvolutionState,
          lastConnectionEventAt: now,
          lastQrAt: hasQrSignal ? now : connection.lastQrAt,
          lastQrGeneratedAt: hasQrSignal ? now : connection.lastQrGeneratedAt,
          lastQrRequestAt: now,
          providerRetryAfterUntil: hasQrSignal || providerResult.status === 'connected'
            ? null
            : providerResult.status === 'qr_not_ready'
              ? new Date(now.getTime() + QR_REQUEST_COOLDOWN_MS)
              : new Date(now.getTime() + TIMEOUT_COOLDOWN_MS),
          lastConnectionAt:
            providerResult.status === 'connected' ? now : connection.lastConnectionAt,
          lastConnectedAt:
            providerResult.status === 'connected' ? now : connection.lastConnectedAt,
          lastError: hasQrSignal || providerResult.status === 'connected'
            ? null
            : providerResult.status === 'qr_not_ready'
              ? 'QR ainda nao esta pronto. Tente novamente em alguns segundos.'
              : 'A Evolution iniciou a conexao, mas ainda nao entregou QR Code. Tente novamente em alguns segundos.',
        },
      });

      return this.buildSnapshot(updated);
    } catch (error) {
      const failureStatus = this.resolveProviderFailureStatus(error);
      const retryAfterUntil = this.resolveProviderRetryAfterUntil(error);
      this.logWhatsappEvent(this.isProviderRateLimitError(error) ? 'whatsapp.qr.request.rate_limited' : 'whatsapp.qr.request.timeout', {
        companyId: connection.companyId,
        instanceName: connection.instanceName,
        message: this.buildProviderUserMessage(error),
      });
      const updated = await this.prisma.whatsappConnection.update({
        where: { id: connection.id },
        data: {
          status: failureStatus,
          connectionState: 'close',
          lastError: this.buildProviderUserMessage(error),
          providerRetryAfterUntil: retryAfterUntil,
          lastQrRequestAt: new Date(),
        },
      });
      return this.buildSnapshot(updated);
    }
  }

  private async syncRemoteState(connection: ConnectionRecord) {
    if (!this.providerService.isConfigured()) {
      return connection;
    }

    if (
      connection.lastEvolutionSyncAt &&
      Date.now() - connection.lastEvolutionSyncAt.getTime() < REMOTE_SYNC_COOLDOWN_MS
    ) {
      return connection;
    }

    const remote = await this.providerService.getInstanceState(connection.instanceName);

    if (connection.userRequestedDisconnect && remote.state === 'open') {
      return this.prisma.whatsappConnection.update({
        where: { id: connection.id },
        data: {
          status: connection.status === 'disconnecting' ? 'disconnecting' : 'disconnected',
          connectionState: remote.state,
          lastEvolutionState: remote.state,
          lastConnectionEventAt: new Date(),
          lastEvolutionSyncAt: new Date(),
          lastError: 'Evolution ainda informou open apos disconnect solicitado',
        },
      });
    }

    const nextStatus = this.mapStateToStatus(remote.state, connection.qrCode);

    return this.prisma.whatsappConnection.update({
      where: { id: connection.id },
      data: {
        status: nextStatus,
        connectionState: remote.state,
        phoneNumber: remote.phoneNumber || connection.phoneNumber,
        qrCode: nextStatus === 'connected' ? null : connection.qrCode,
        qrCodeText: nextStatus === 'connected' ? null : connection.qrCodeText,
        pairingCode: nextStatus === 'connected' ? null : connection.pairingCode,
        webhookUrl: connection.webhookUrl,
        lastEvolutionState: remote.state,
        lastConnectionEventAt: new Date(),
        lastEvolutionSyncAt: new Date(),
        lastConnectionAt:
          nextStatus === 'connected' ? connection.lastConnectionAt || new Date() : connection.lastConnectionAt,
        lastConnectedAt:
          nextStatus === 'connected' ? connection.lastConnectedAt || new Date() : connection.lastConnectedAt,
        lastDisconnectedAt:
          nextStatus === 'disconnected' ? new Date() : connection.lastDisconnectedAt,
      },
    });
  }

  private buildSnapshot(connection: ConnectionRecord | null, forcedRetryAfterSeconds?: number | null) {
    if (!connection) {
      return {
        id: null,
        companyId: null,
        provider: 'evolution',
        instanceName: null,
        status: 'not_configured',
        qrCode: null,
        code: null,
        pairingCode: null,
        phoneNumber: null,
        webhookUrl: null,
        webhookStatus: 'pending',
        automationStatus: this.resolveAutomationStatus(),
        lastError: null,
        message: 'WhatsApp desconectado',
        retryAfterSeconds: forcedRetryAfterSeconds ?? null,
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
      connectionState: connection.connectionState,
      qrCode: connection.qrCode,
      code: connection.qrCodeText || connection.qrCode,
      pairingCode: connection.pairingCode,
      phoneNumber: connection.phoneNumber,
      webhookUrl: this.redactSensitiveUrl(connection.webhookUrl),
      webhookStatus: connection.webhookLastError
        ? 'error'
        : connection.webhookEnabled && connection.webhookUrl
          ? 'configured'
          : 'pending',
      automationStatus: this.resolveAutomationStatus(),
      lastError: connection.lastError,
      message: this.resolveSnapshotMessage(connection),
      retryAfterSeconds:
        forcedRetryAfterSeconds ??
        this.resolveRetryAfterSeconds(connection),
      expiresInSeconds:
        connection.status === 'qr_pending' && (connection.qrCode || connection.pairingCode)
          ? 60
          : null,
      sessionGeneration: connection.sessionGeneration,
      userRequestedDisconnect: connection.userRequestedDisconnect,
      lastConnectionAt: connection.lastConnectedAt?.toISOString() || connection.lastConnectionAt?.toISOString() || null,
      lastDisconnectedAt: connection.lastDisconnectedAt?.toISOString() || null,
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

  private resolveRetryAfterSeconds(connection: ConnectionRecord) {
    return (
      this.getProviderRetryAfterSeconds(connection) ||
      this.getCooldownSeconds(connection.lastQrRequestAt, QR_REQUEST_COOLDOWN_MS) ||
      this.getCooldownSeconds(connection.lastConnectStartAt, CONNECT_START_COOLDOWN_MS) ||
      (connection.status === 'qr_not_ready' ? 15 : null)
    );
  }

  private getProviderRetryAfterSeconds(connection?: { providerRetryAfterUntil?: Date | null } | null) {
    if (!connection?.providerRetryAfterUntil) {
      return 0;
    }

    return this.getSecondsUntil(connection.providerRetryAfterUntil);
  }

  private getCooldownSeconds(value: Date | null | undefined, cooldownMs: number) {
    if (!value) {
      return 0;
    }

    return this.getSecondsUntil(new Date(value.getTime() + cooldownMs));
  }

  private getSecondsUntil(value: Date) {
    const diff = value.getTime() - Date.now();
    return diff > 0 ? Math.ceil(diff / 1000) : 0;
  }

  private buildInstanceName(companyId: string) {
    return `nextlevel-company-${companyId}`;
  }

  private buildGeneratedInstanceName(companyId: string, sessionGeneration: number) {
    return `${this.buildInstanceName(companyId)}-g${Math.max(sessionGeneration, 1)}`;
  }

  private resolveNextSessionGeneration(
    existing: { sessionGeneration?: number; status?: string; userRequestedDisconnect?: boolean; instanceName?: string } | null,
  ) {
    if (!existing) {
      return 1;
    }

    return this.shouldRotateInstance(existing, existing.instanceName || '')
      ? (existing.sessionGeneration || 1) + 1
      : existing.sessionGeneration || 1;
  }

  private shouldRotateInstance(
    existing: { status?: string; userRequestedDisconnect?: boolean; instanceName?: string } | null,
    instanceName: string,
  ) {
    if (!existing) {
      return false;
    }

    return (
      Boolean(existing.userRequestedDisconnect) ||
      ['disconnected', 'disconnected_requires_new_qr', 'disconnected_pending_provider_cleanup'].includes(existing.status || '') ||
      this.isLegacySharedInstanceName(instanceName)
    );
  }

  private isLegacySharedInstanceName(instanceName: string | null | undefined) {
    const normalized = this.readString(instanceName)?.toLowerCase();
    return Boolean(normalized && LEGACY_SHARED_INSTANCE_NAMES.has(normalized));
  }

  private async resolveInstanceName(
    companyId: string,
    dto: ConnectWhatsappDto,
    existing: { instanceName: string; status?: string; userRequestedDisconnect?: boolean } | null,
    sessionGeneration: number,
  ) {
    const requested = this.readString(dto.instanceName);
    if (requested) {
      return requested;
    }

    if (existing?.instanceName && !this.shouldRotateInstance(existing, existing.instanceName)) {
      return existing.instanceName;
    }

    const legacy = await this.prisma.whatsappInstance.findUnique({
      where: { companyId },
      select: { instanceName: true },
    });

    if (legacy?.instanceName && !this.isLegacySharedInstanceName(legacy.instanceName)) {
      return legacy.instanceName;
    }

    return this.buildGeneratedInstanceName(companyId, sessionGeneration);
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
    await this.providerService.setWebhook(instanceName, webhookUrl, this.getWebhookEvents());
  }

  private async ensureWebhookIfMissing(instanceName: string, webhookUrl: string) {
    const events = this.getWebhookEvents();
    this.validateWebhookConfig(webhookUrl, events);

    const connection = await this.prisma.whatsappConnection.findUnique({
      where: { instanceName },
    });
    const configHash = this.hashWebhookConfig(webhookUrl, events);

    if (
      connection?.webhookEnabled &&
      connection.webhookUrl === webhookUrl &&
      connection.webhookConfigHash === configHash &&
      !connection.webhookLastError
    ) {
      return;
    }

    let currentWebhook: unknown = null;
    try {
      currentWebhook = await this.providerService.getWebhook(instanceName);
    } catch (error) {
      this.logger.warn(
        `Nao foi possivel consultar webhook Evolution para ${instanceName}; tentando provisionar uma vez: ${this.extractErrorMessage(error)}`,
      );
    }

    const current = this.extractWebhookState(currentWebhook);
    if (current.enabled && current.url === webhookUrl && this.sameEvents(current.events, events)) {
      await this.prisma.whatsappConnection.update({
        where: { instanceName },
        data: {
          webhookEnabled: true,
          webhookLastError: null,
          webhookConfigHash: configHash,
          webhookUrl,
        },
      });
      return;
    }

    if (
      connection?.webhookLastConfiguredAt &&
      Date.now() - connection.webhookLastConfiguredAt.getTime() < WEBHOOK_RECONFIGURE_COOLDOWN_MS
    ) {
      this.logger.warn(
        `Webhook Evolution divergente para ${instanceName}, mas reconfiguracao ignorada por cooldown.`,
      );
      return;
    }

    try {
      this.logger.log(
        JSON.stringify({
          event: 'evolution.webhook.configure',
          instanceName,
          payload: {
            url: this.redactSensitiveUrl(webhookUrl),
            webhook_by_events: false,
            webhook_base64: true,
            events,
          },
        }),
      );
      await this.configureProviderWebhook(instanceName, webhookUrl);
      await this.prisma.whatsappConnection.update({
        where: { instanceName },
        data: {
          webhookUrl,
          webhookEnabled: true,
          webhookLastConfiguredAt: new Date(),
          webhookLastError: null,
          webhookConfigHash: configHash,
        },
      });
    } catch (error) {
      const message = this.extractErrorMessage(error);
      await this.prisma.whatsappConnection.update({
        where: { instanceName },
        data: {
          webhookLastError: message,
          webhookLastConfiguredAt: new Date(),
        },
      });

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
      'CONNECTION_UPDATE',
      'MESSAGES_UPSERT',
      'MESSAGES_UPDATE',
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

  private async saveWebhookEvent(companyId: string, payload: Record<string, unknown>) {
    await this.prisma.webhookEvent
      .create({
        data: {
          companyId,
          provider: 'WHATSAPP',
          payload: payload as Prisma.InputJsonValue,
        },
      })
      .catch((error) => {
        this.logger.warn(`Falha ao salvar evento WhatsApp: ${this.extractErrorMessage(error)}`);
      });
  }

  private async withOperationLock<T>(companyId: string, operation: () => Promise<T>) {
    const key = `whatsapp:${companyId}`;
    const token = randomUUID();
    const now = new Date();
    const lockUntil = new Date(now.getTime() + OPERATION_LOCK_TTL_MS);

    if (this.operationLocks.has(key)) {
      throw new ConflictException('Operacao de conexao ja esta em andamento');
    }

    const current = await this.prisma.whatsappConnection.findUnique({
      where: { companyId },
      select: { operationLockUntil: true },
    });

    if (current?.operationLockUntil && current.operationLockUntil > now) {
      throw new ConflictException('Operacao de conexao ja esta em andamento');
    }

    this.operationLocks.set(key, token);
    await this.prisma.whatsappConnection
      .update({
        where: { companyId },
        data: { operationLockUntil: lockUntil },
      })
      .catch(() => undefined);

    const timeout = setTimeout(() => {
      if (this.operationLocks.get(key) === token) {
        this.operationLocks.delete(key);
      }
    }, OPERATION_LOCK_TTL_MS);

    try {
      return await operation();
    } finally {
      clearTimeout(timeout);
      if (this.operationLocks.get(key) === token) {
        this.operationLocks.delete(key);
      }
      await this.prisma.whatsappConnection
        .update({
          where: { companyId },
          data: { operationLockUntil: null },
        })
        .catch(() => undefined);
    }
  }

  private assertProviderActionAllowed(
    instanceName: string,
    action: string,
    cooldownMs: number,
  ) {
    const key = `${instanceName}:${action}`;
    const now = Date.now();
    const blockedUntil = this.providerActionCooldowns.get(key) || 0;

    if (blockedUntil > now) {
      throw new ConflictException(
        'A Evolution limitou as requisicoes. Aguarde alguns segundos antes de tentar novamente.',
      );
    }

    this.providerActionCooldowns.set(key, now + cooldownMs);
  }

  private async isAutomationEnabled(companyId: string) {
    const config = await this.prisma.agentConfig.findUnique({
      where: { companyId },
      select: { isEnabled: true },
    });

    return config?.isEnabled === true;
  }

  private resolveWebhookStatus(connection: ConnectionRecord, state: string) {
    if (connection.userRequestedDisconnect && state === 'open') {
      return connection.status === 'disconnecting' ? 'disconnecting' : 'disconnected';
    }

    return this.mapStateToStatus(state, connection.qrCode);
  }

  private validateWebhookConfig(webhookUrl: string, events: string[]) {
    try {
      const url = new URL(webhookUrl);
      if (url.protocol !== 'https:' && !url.hostname.includes('localhost')) {
        throw new Error('invalid protocol');
      }
    } catch {
      throw new BadRequestException('URL de webhook Evolution invalida');
    }

    if (!events.length) {
      throw new BadRequestException('Eventos de webhook Evolution nao podem estar vazios');
    }
  }

  private hashWebhookConfig(webhookUrl: string, events: string[]) {
    return createHash('sha256')
      .update(JSON.stringify({ webhookUrl, events: [...events].sort() }))
      .digest('hex');
  }

  private sameEvents(currentEvents: string[], expectedEvents: string[]) {
    if (!currentEvents.length) {
      return false;
    }

    const current = [...new Set(currentEvents)].sort().join('|');
    const expected = [...new Set(expectedEvents)].sort().join('|');
    return current === expected;
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

  private normalizePhone(value: string | null) {
    if (!value) {
      return null;
    }

    const normalized = value
      .replace('@s.whatsapp.net', '')
      .replace('@c.us', '')
      .replace(/\D/g, '');

    return normalized || null;
  }

  private mapStateToStatus(state: string, qrCode: string | null) {
    if (state === 'open') {
      return 'connected';
    }

    if (qrCode) {
      return 'qr_pending';
    }

    if (state === 'connecting') {
      return 'connecting';
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
    const rawEvents = webhook?.events ?? nested?.events;

    return {
      url:
        this.readString(webhook?.url) ||
        this.readString(nested?.url),
      enabled:
        rawEnabled === true ||
        this.readString(rawEnabled)?.toLowerCase() === 'true',
      events: Array.isArray(rawEvents)
        ? rawEvents.map((item) => this.readString(item)).filter(Boolean) as string[]
        : [],
    };
  }

  private isInstanceRequiresWebhookError(error: unknown) {
    const message = this.extractErrorMessage(error).toLowerCase();
    return (
      message.includes('instance') &&
      message.includes('requires') &&
      message.includes('webhook')
    );
  }

  private isProviderRateLimitError(error: unknown) {
    return (
      (error as { providerStatusCode?: number })?.providerStatusCode === 429 ||
      this.extractErrorMessage(error).toLowerCase().includes('limitou') ||
      this.extractErrorMessage(error).toLowerCase().includes('too many requests')
    );
  }

  private buildProviderUserMessage(error: unknown) {
    if (this.isProviderRateLimitError(error)) {
      return 'A Evolution limitou as requisicoes. Aguarde alguns segundos antes de tentar novamente.';
    }

    const message = this.extractErrorMessage(error);
    if (message.toLowerCase().includes('timeout')) {
      return 'A Evolution esta aquecendo ou demorou para responder. Tente novamente em alguns segundos.';
    }

    return message;
  }

  private resolveProviderFailureStatus(error: unknown) {
    if (this.isProviderRateLimitError(error)) {
      return 'rate_limited';
    }

    const message = this.extractErrorMessage(error).toLowerCase();
    if (
      message.includes('timeout') ||
      message.includes('econnreset') ||
      message.includes('socket hang up') ||
      message.includes('network') ||
      message.includes('503') ||
      message.includes('502')
    ) {
      return 'provider_warming_up';
    }

    return 'error';
  }

  private resolveProviderRetryAfterUntil(error: unknown) {
    const retryAfterMs = this.extractProviderRetryAfterMs(error);
    if (this.isProviderRateLimitError(error)) {
      return new Date(Date.now() + Math.max(retryAfterMs || 0, RATE_LIMIT_COOLDOWN_MS));
    }

    const status = this.resolveProviderFailureStatus(error);
    if (status === 'provider_warming_up') {
      return new Date(Date.now() + Math.max(retryAfterMs || 0, TIMEOUT_COOLDOWN_MS));
    }

    return null;
  }

  private extractProviderRetryAfterMs(error: unknown) {
    const response = (error as { providerResponse?: unknown })?.providerResponse;
    const retryAfterMs = this.asRecord(response)?.retryAfterMs;
    const retryAfterSeconds = this.asRecord(response)?.retryAfterSeconds;
    const ms = Number(retryAfterMs);
    if (Number.isFinite(ms) && ms > 0) {
      return ms;
    }

    const seconds = Number(retryAfterSeconds);
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
  }

  private resolveSnapshotMessage(connection: ConnectionRecord) {
    if (connection.lastError) {
      return connection.lastError;
    }

    if (connection.status === 'qr_pending' && (connection.qrCode || connection.pairingCode)) {
      return 'QR Code gerado';
    }

    if (connection.status === 'connected') {
      return 'WhatsApp conectado';
    }

    if (connection.status === 'provider_warming_up') {
      return 'A Evolution ainda esta iniciando. Tente novamente em alguns segundos.';
    }

    if (connection.status === 'rate_limited') {
      return 'A Evolution limitou as requisicoes. Aguarde alguns segundos antes de tentar novamente.';
    }

    if (connection.status === 'qr_not_ready') {
      return 'QR ainda nao esta pronto. Tente novamente em alguns segundos.';
    }

    if (connection.status === 'repair_ready') {
      return 'Reparo preparado. Clique em Conectar WhatsApp para gerar um novo QR Code.';
    }

    if (connection.status === 'disconnected') {
      return 'WhatsApp desconectado';
    }

    return null;
  }

  private logWhatsappEvent(event: string, payload: Record<string, unknown>) {
    this.logger.log(JSON.stringify({ event, ...payload }));
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
