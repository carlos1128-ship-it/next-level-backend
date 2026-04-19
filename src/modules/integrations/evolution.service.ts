import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../prisma/prisma.service';

type EvolutionEventName =
  | 'QRCODE_UPDATED'
  | 'CONNECTION_UPDATE'
  | 'MESSAGES_UPSERT';

type EvolutionWebhookPayload = {
  event?: string;
  instance?: string;
  data?: {
    state?: string;
    qrcode?: {
      base64?: string;
    };
    messages?: Array<{
      pushName?: string;
      key?: {
        fromMe?: boolean;
        remoteJid?: string;
      };
      message?: {
        conversation?: string;
        extendedTextMessage?: {
          text?: string;
        };
        imageMessage?: {
          caption?: string;
        };
        videoMessage?: {
          caption?: string;
        };
      };
    }>;
  };
};

@Injectable()
export class EvolutionService {
  private readonly logger = new Logger(EvolutionService.name);
  private readonly api: AxiosInstance;

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
  ) {
    this.api = axios.create({
      baseURL: process.env.EVOLUTION_API_URL,
      headers: {
        apikey: process.env.EVOLUTION_API_KEY,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    });
  }

  async createInstance(companyId: string): Promise<void> {
    this.ensureConfigured();

    const instanceName = this.getInstanceName(companyId);
    const webhookUrl = `${this.getBackendUrl()}/api/evolution/webhook`;

    await this.api.delete(`/instance/delete/${instanceName}`).catch(() => undefined);
    await this.delay(1000);

    await this.api.post('/instance/create', {
      instanceName,
      qrcode: true,
      integration: 'WHATSAPP-BAILEYS',
    });

    await this.api.post(`/webhook/set/${instanceName}`, {
      webhook: {
        enabled: true,
        url: webhookUrl,
        byEvents: false,
        base64: true,
        events: [
          'MESSAGES_UPSERT',
          'QRCODE_UPDATED',
          'CONNECTION_UPDATE',
          'SEND_MESSAGE',
        ],
      },
    });

    await this.prisma.company.update({
      where: { id: companyId },
      data: { evolutionConnected: false },
    }).catch(() => undefined);

    this.logger.log(`[Evolution][${companyId}] Instancia criada: ${instanceName}`);
  }

  async getQRCode(companyId: string): Promise<string | null> {
    this.ensureConfigured();

    const instanceName = this.getInstanceName(companyId);

    try {
      const response = await this.api.get(`/instance/connect/${instanceName}`);
      const base64 =
        this.asString(response.data?.base64) ||
        this.asString(response.data?.qrcode?.base64) ||
        this.asString(response.data?.qrcode);

      return this.normalizeQrCode(base64);
    } catch {
      return null;
    }
  }

  async getConnectionStatus(companyId: string): Promise<string> {
    this.ensureConfigured();

    const instanceName = this.getInstanceName(companyId);

    try {
      const response = await this.api.get(`/instance/connectionState/${instanceName}`);
      return this.asString(response.data?.instance?.state) || 'close';
    } catch {
      return 'close';
    }
  }

  async sendTextMessage(companyId: string, to: string, text: string): Promise<void> {
    this.ensureConfigured();

    const instanceName = this.getInstanceName(companyId);
    const number = this.normalizeNumber(to);

    await this.api.post(`/message/sendText/${instanceName}`, {
      number,
      textMessage: { text },
    });
  }

  async disconnectInstance(companyId: string): Promise<void> {
    this.ensureConfigured();

    const instanceName = this.getInstanceName(companyId);

    await this.api.delete(`/instance/logout/${instanceName}`).catch(() => undefined);
    await this.api.delete(`/instance/delete/${instanceName}`).catch(() => undefined);
    await this.prisma.company.update({
      where: { id: companyId },
      data: { evolutionConnected: false },
    }).catch(() => undefined);

    this.eventEmitter.emit('whatsapp.status.updated', {
      companyId,
      status: 'close',
    });

    this.logger.log(`[Evolution][${companyId}] Instancia desconectada`);
  }

  async processWebhook(payload: Record<string, unknown>): Promise<void> {
    const event = this.asEvolutionEvent(payload.event);
    const instanceName = this.asString(payload.instance);

    if (!event || !instanceName) {
      return;
    }

    const companyId = this.extractCompanyId(instanceName);
    if (!companyId) {
      return;
    }

    const data = (payload.data as EvolutionWebhookPayload['data']) || {};

    if (event === 'QRCODE_UPDATED') {
      const qrcode = this.normalizeQrCode(data?.qrcode?.base64 || null);
      if (!qrcode) {
        return;
      }

      this.eventEmitter.emit('whatsapp.qr.generated', {
        companyId,
        qrCode: qrcode,
        attempts: 0,
        sessionName: instanceName,
      });
      this.eventEmitter.emit('whatsapp.status.updated', {
        companyId,
        status: 'qr_ready',
      });
      this.logger.log(`[Evolution][${companyId}] QR Code atualizado`);
      return;
    }

    if (event === 'CONNECTION_UPDATE') {
      const state = this.asString(data?.state) || 'close';
      const connected = state === 'open';

      await this.prisma.company.update({
        where: { id: companyId },
        data: {
          evolutionConnected: connected,
          lastConnectedAt: connected ? new Date() : undefined,
        },
      }).catch(() => undefined);

      this.eventEmitter.emit('whatsapp.status.updated', {
        companyId,
        status: state,
      });
      this.logger.log(`[Evolution][${companyId}] Conexao: ${state}`);
      return;
    }

    if (event === 'MESSAGES_UPSERT') {
      const messages = Array.isArray(data?.messages) ? data.messages : [];

      for (const message of messages) {
        if (message?.key?.fromMe) {
          continue;
        }

        const remoteJid = this.asString(message?.key?.remoteJid);
        if (!remoteJid || remoteJid.includes('@g.us')) {
          continue;
        }

        const text =
          this.asString(message?.message?.conversation) ||
          this.asString(message?.message?.extendedTextMessage?.text) ||
          this.asString(message?.message?.imageMessage?.caption) ||
          this.asString(message?.message?.videoMessage?.caption);

        if (!text) {
          continue;
        }

        this.eventEmitter.emit('whatsapp.message.received', {
          companyId,
          from: this.normalizeInboundNumber(remoteJid),
          text,
          name: this.asString(message?.pushName) || undefined,
        });
      }
    }
  }

  private getInstanceName(companyId: string): string {
    return `nextlevel-${companyId}`;
  }

  private extractCompanyId(instanceName: string): string | null {
    if (!instanceName.startsWith('nextlevel-')) {
      return null;
    }

    const companyId = instanceName.replace('nextlevel-', '').trim();
    return companyId || null;
  }

  private normalizeQrCode(value: string | null): string | null {
    if (!value) {
      return null;
    }

    return value.startsWith('data:') ? value : `data:image/png;base64,${value}`;
  }

  private normalizeNumber(value: string): string {
    if (value.includes('@')) {
      return value;
    }

    const digits = value.replace(/\D/g, '');
    if (!digits) {
      throw new BadRequestException('Numero de destino invalido');
    }

    return `${digits}@s.whatsapp.net`;
  }

  private normalizeInboundNumber(value: string): string {
    return value
      .replace('@s.whatsapp.net', '')
      .replace('@c.us', '');
  }

  private asString(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
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
    const backendUrl = this.asString(process.env.BACKEND_URL);
    if (!backendUrl) {
      throw new BadRequestException('BACKEND_URL nao configurado no servidor');
    }

    return backendUrl.replace(/\/+$/, '');
  }

  private ensureConfigured(): void {
    if (!this.asString(process.env.EVOLUTION_API_URL)) {
      throw new BadRequestException('EVOLUTION_API_URL nao configurada no servidor');
    }

    if (!this.asString(process.env.EVOLUTION_API_KEY)) {
      throw new BadRequestException('EVOLUTION_API_KEY nao configurada no servidor');
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
