import {
  Body,
  Controller,
  Get,
  Headers,
  Logger,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IntegrationProvider } from '@prisma/client';
import { Public } from '../../common/decorators/public.decorator';
import { WebhooksMetaService } from './webhooks-meta.service';
import { WebhookIngestService } from './webhook-ingest.service';
import * as crypto from 'crypto';

@Controller('webhooks')
export class WebhooksController {
  constructor(
    private readonly configService: ConfigService,
    private readonly webhooksMetaService: WebhooksMetaService,
    private readonly webhookIngestService: WebhookIngestService,
  ) {}

  private readonly logger = new Logger(WebhooksController.name);

  @Public()
  @Get('meta')
  verify(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
  ) {
    const verifyToken =
      this.configService.get<string>('META_WEBHOOK_VERIFY_TOKEN') ||
      this.configService.get<string>('META_VERIFY_TOKEN');

    if (mode === 'subscribe' && verifyToken && token === verifyToken) {
      return challenge;
    }

    return { ok: false, message: 'Verificacao Meta falhou' };
  }

  @Public()
  @Post('meta')
  async handleMeta(
    @Headers('x-hub-signature-256') signature: string,
    @Body() body: Record<string, unknown>,
  ) {
    const provider = this.detectMetaProvider(body);
    const externalId = this.extractMetaExternalId(body);
    const signatureValid = this.isValidMetaSignature(signature, body);
    const companyIdHint = this.extractCompanyId(body);

    try {
      const { event, companyId } = await this.webhookIngestService.registerEvent(
        provider,
        body,
        externalId,
        companyIdHint,
      );

      setImmediate(() => {
        if (body?.['object'] === 'ad_account') {
          this.webhooksMetaService
            .processWebhook(body)
            .catch((error) =>
              this.logger.error('Erro ao processar webhook Meta Ads', error as Error),
            );
        }
      });

      return {
        ok: true,
        eventId: event.id,
        companyId,
        signatureValid,
      };
    } catch (error) {
      this.logger.error('Falha ao salvar webhook Meta', error as Error);
      return { ok: true, stored: false, signatureValid };
    }
  }

  @Public()
  @Post('mercadolivre')
  async handleMercadoLivre(@Body() body: Record<string, unknown>) {
    const externalId = this.extractMercadoLivreExternalId(body);
    const companyIdHint = this.extractCompanyId(body);

    try {
      const { event, companyId } = await this.webhookIngestService.registerEvent(
        IntegrationProvider.MERCADOLIVRE,
        body,
        externalId,
        companyIdHint,
      );

      return {
        ok: true,
        eventId: event.id,
        companyId,
      };
    } catch (error) {
      this.logger.error('Falha ao salvar webhook Mercado Livre', error as Error);
      return { ok: true, stored: false };
    }
  }

  private detectMetaProvider(payload: Record<string, unknown>): IntegrationProvider {
    const object = payload?.['object'];
    if (object === 'instagram' || object === 'instagram_business_account') {
      return IntegrationProvider.INSTAGRAM;
    }

    return IntegrationProvider.WHATSAPP;
  }

  private extractMetaExternalId(payload: Record<string, unknown>): string | null {
    const entry = (payload?.['entry'] as Array<Record<string, unknown>>)?.[0];
    const change = (entry?.['changes'] as Array<Record<string, unknown>>)?.[0];
    const value = change?.['value'] as Record<string, unknown> | undefined;
    const phoneId = (value?.['metadata'] as Record<string, unknown> | undefined)?.[
      'phone_number_id'
    ] as string | undefined;

    if (phoneId) return phoneId;

    if (typeof entry?.['id'] === 'string') return entry.id as string;
    return null;
  }

  private extractMercadoLivreExternalId(payload: Record<string, unknown>): string | null {
    const userId = payload?.['user_id'] || payload?.['seller_id'];
    if (typeof userId === 'string' || typeof userId === 'number') {
      return String(userId);
    }

    const seller = payload?.['seller'] as Record<string, unknown> | undefined;
    if (seller?.['id']) {
      return String(seller['id']);
    }

    const resource = payload?.['resource'];
    if (typeof resource === 'string') {
      const match = resource.match(/users\/([0-9]+)/);
      if (match?.[1]) return match[1];
    }

    return null;
  }

  private isValidMetaSignature(
    signature: string | undefined,
    body: Record<string, unknown>,
  ): boolean {
    const appSecret =
      this.configService.get<string>('META_APP_SECRET') ||
      this.configService.get<string>('META_SECRET');

    if (!appSecret || !signature) return true;

    const expected =
      'sha256=' +
      crypto
        .createHmac('sha256', appSecret)
        .update(JSON.stringify(body))
        .digest('hex');

    return expected === signature;
  }

  /**
   * Recebe webhooks da Evolution API (WhatsApp self-hosted).
   * URL configurada no Evolution como: {SERVER_URL}/webhooks/evolution/{companyId}
   */
  @Public()
  @Post('evolution/:companyId')
  async handleEvolution(
    @Param('companyId') companyId: string,
    @Headers('apikey') apiKey: string,
    @Body() body: Record<string, unknown>,
  ) {
    const expectedKey = this.configService.get<string>('EVOLUTION_API_KEY');
    if (expectedKey && apiKey !== expectedKey) {
      return { ok: false };
    }

    // Filtra apenas eventos de mensagens recebidas
    const event = body?.['event'] as string | undefined;
    if (event !== 'messages.upsert') {
      return { ok: true, ignored: true };
    }

    const data = body?.['data'] as Record<string, unknown> | undefined;
    const key = data?.['key'] as Record<string, unknown> | undefined;
    if (key?.['fromMe'] === true) {
      return { ok: true, ignored: true };
    }

    const instanceName = (body?.['instance'] as string | undefined) || '';

    try {
      await this.webhookIngestService.registerEvent(
        IntegrationProvider.WHATSAPP,
        body,
        instanceName,
        companyId,
      );
      return { ok: true };
    } catch (error) {
      this.logger.error('Falha ao salvar webhook Evolution', error as Error);
      return { ok: true, stored: false };
    }
  }

  private extractCompanyId(payload: Record<string, unknown>): string | null {
    const direct = payload?.['companyId'] || payload?.['company_id'];
    if (typeof direct === 'string' && direct.trim()) return direct.trim();
    return null;
  }
}
