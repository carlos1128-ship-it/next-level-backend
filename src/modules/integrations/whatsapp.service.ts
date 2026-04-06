import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IntegrationProvider } from '@prisma/client';
import axios from 'axios';
import { IntegrationsService } from './integrations.service';
import { MetaGraphService } from './meta-graph.service';

interface SendTemplateInput {
  to: string;
  template: string;
  language?: string;
  components?: Array<Record<string, unknown>>;
}

interface EvolutionConnectionSnapshot {
  instanceName?: string;
  qrCode?: string;
  status: string;
}

@Injectable()
export class WhatsappService {
  private readonly logger = new Logger(WhatsappService.name);

  constructor(
    private readonly integrationsService: IntegrationsService,
    private readonly metaGraphService: MetaGraphService,
    private readonly configService: ConfigService,
  ) {}

  private get evolutionUrl() {
    return (this.configService.get<string>('EVOLUTION_API_URL') || 'http://localhost:8080').replace(/\/$/, '');
  }

  private get evolutionKey() {
    return this.configService.get<string>('EVOLUTION_API_KEY') || '';
  }

  private normalizeQrCode(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    if (trimmed.startsWith('data:image')) return trimmed;
    return `data:image/png;base64,${trimmed}`;
  }

  private normalizeEvolutionStatus(state: unknown): string {
    const normalized = typeof state === 'string' ? state.trim().toLowerCase() : '';
    if (['open', 'connected'].includes(normalized)) return 'Connected';
    if (['connecting', 'qrcode', 'qr', 'scan', 'pairing'].includes(normalized)) return 'Connecting';
    if (['close', 'closed', 'disconnected', 'not_created'].includes(normalized)) return 'Disconnected';
    return normalized ? normalized.charAt(0).toUpperCase() + normalized.slice(1) : 'Disconnected';
  }

  // ─── Meta Cloud API ────────────────────────────────────────────────────────

  async sendTextMessage(companyId: string, to: string, message: string) {
    const integration = await this.integrationsService.getActiveIntegration(
      companyId,
      IntegrationProvider.WHATSAPP,
    );

    await this.metaGraphService.requestWithRetry({
      companyId,
      method: 'POST',
      path: `${integration.externalId}/messages`,
      accessToken: integration.accessToken,
      data: {
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: message },
      },
    });

    return { sent: true };
  }

  async sendTemplateMessage(companyId: string, payload: SendTemplateInput) {
    const integration = await this.integrationsService.getActiveIntegration(
      companyId,
      IntegrationProvider.WHATSAPP,
    );

    if (!payload.template) {
      throw new BadRequestException('template obrigatorio');
    }

    await this.metaGraphService.requestWithRetry({
      companyId,
      method: 'POST',
      path: `${integration.externalId}/messages`,
      accessToken: integration.accessToken,
      data: {
        messaging_product: 'whatsapp',
        to: payload.to,
        type: 'template',
        template: {
          name: payload.template,
          language: { code: payload.language || 'pt_BR' },
          components: payload.components,
        },
      },
    });

    return { sent: true };
  }

  async discoverBusinessProfile(accessToken: string) {
    return this.metaGraphService.discoverWhatsappBusiness(accessToken);
  }

  // ─── Evolution API ─────────────────────────────────────────────────────────

  /**
   * Cria uma instância no Evolution API e retorna o QR code base64.
   * O webhookUrl deve apontar para /webhooks/evolution/{companyId}.
   */
  async createEvolutionInstance(
    instanceName: string,
    webhookUrl: string,
  ): Promise<EvolutionConnectionSnapshot> {
    try {
      const { data } = await axios.post(
        `${this.evolutionUrl}/instance/create`,
        {
          instanceName,
          qrcode: true,
          webhook: webhookUrl,
          webhookByEvents: false,
          events: ['MESSAGES_UPSERT'],
        },
        {
          headers: { apikey: this.evolutionKey },
          timeout: 15000,
        },
      );

      const qrCode = this.normalizeQrCode(
        data?.base64 || data?.qrcode?.base64 || data?.qrcode,
      );
      const status = this.normalizeEvolutionStatus(
        data?.instance?.state || data?.instance?.status || data?.state,
      );
      return {
        instanceName,
        qrCode,
        status: qrCode ? 'Connecting' : status,
      };
    } catch (error) {
      if (axios.isAxiosError(error)) {
        this.logger.error(
          `Falha ao criar instancia Evolution: status=${error.response?.status ?? 'no-response'} code=${error.code ?? 'unknown'} url=${this.evolutionUrl}/instance/create body=${JSON.stringify(error.response?.data ?? null)}`,
        );
      } else {
        this.logger.error(`Falha ao criar instancia Evolution: ${(error as Error).message}`);
      }
      throw new BadRequestException('Falha ao criar instancia no Evolution API. Verifique EVOLUTION_API_URL e EVOLUTION_API_KEY.');
    }
  }

  /**
   * Retorna o QR code atual para uma instância desconectada, ou
   * { status: 'open' } se já estiver conectada.
   */
  async getEvolutionQRCode(instanceName: string): Promise<EvolutionConnectionSnapshot> {
    try {
      const { data } = await axios.get(
        `${this.evolutionUrl}/instance/connect/${instanceName}`,
        {
          headers: { apikey: this.evolutionKey },
          timeout: 10000,
        },
      );

      const status = this.normalizeEvolutionStatus(
        data?.instance?.state || data?.instance?.status || data?.state,
      );
      const qrCode = this.normalizeQrCode(
        data?.base64 || data?.qrcode?.base64 || data?.qrcode,
      );

      return {
        instanceName,
        qrCode,
        status: qrCode ? 'Connecting' : status,
      };
    } catch (error) {
      this.logger.warn(
        `Falha ao consultar QR code da instancia ${instanceName}: ${(error as Error).message}`,
      );
      return { instanceName, status: 'Error' };
    }
  }

  /**
   * Verifica o estado de conexão de uma instância.
   * Retorna: 'open' | 'connecting' | 'close' | 'error'
   */
  async getEvolutionConnectionState(instanceName: string): Promise<string> {
    try {
      const { data } = await axios.get(
        `${this.evolutionUrl}/instance/connectionState/${instanceName}`,
        {
          headers: { apikey: this.evolutionKey },
          timeout: 8000,
        },
      );
      return this.normalizeEvolutionStatus(data?.instance?.state || data?.instance?.status || data?.state);
    } catch {
      return 'Error';
    }
  }

  /**
   * Envia uma mensagem de texto via Evolution API.
   * O phone deve ser só o número: ex. 5511999999999
   */
  async sendEvolutionMessage(instanceName: string, phone: string, text: string): Promise<void> {
    await axios.post(
      `${this.evolutionUrl}/message/sendText/${instanceName}`,
      { number: phone, text },
      {
        headers: { apikey: this.evolutionKey },
        timeout: 10000,
      },
    );
  }
}
