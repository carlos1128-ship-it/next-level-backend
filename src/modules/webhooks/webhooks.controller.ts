import {
  Body,
  Controller,
  Get,
  Headers,
  Logger,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IntegrationProvider } from '@prisma/client';
import { Request, Response } from 'express';
import { Public } from '../../common/decorators/public.decorator';
import { PrismaService } from '../../prisma/prisma.service';
import { WebhooksMetaService } from './webhooks-meta.service';
import { WebhookIngestService } from './webhook-ingest.service';
import * as crypto from 'crypto';

@Controller('webhooks')
export class WebhooksController {
  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly webhooksMetaService: WebhooksMetaService,
    private readonly webhookIngestService: WebhookIngestService,
  ) {}

  private readonly logger = new Logger(WebhooksController.name);

  @Public()
  @Get('meta')
  async verify(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
    @Res() res: Response,
  ) {
    const globalToken =
      this.configService.get<string>('META_WEBHOOK_VERIFY_TOKEN') ||
      this.configService.get<string>('META_VERIFY_TOKEN');

    const companyToken = token
      ? await this.prisma.company.findFirst({
          where: { webhookVerifyToken: token },
          select: { id: true },
        })
      : null;

    if (
      mode === 'subscribe' &&
      token &&
      ((globalToken && token === globalToken) || companyToken)
    ) {
      return res.status(200).send(challenge);
    }

    return res.status(403).send('Verificacao Meta falhou');
  }

  @Public()
  @Post('meta')
  async handleMeta(
    @Req() req: Request & { rawBody?: Buffer },
    @Res() res: Response,
    @Headers('x-hub-signature-256') signature: string,
    @Body() body: Record<string, unknown>,
  ) {
    const provider = this.detectMetaProvider(body);
    const externalId = this.extractMetaExternalId(body);
    const signatureValid = this.isValidMetaSignature(signature, req.rawBody, body);
    const companyIdHint = this.extractCompanyId(body);

    if (!signatureValid) {
      return res.status(401).json({ ok: false, error: 'Assinatura Meta invalida' });
    }

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

      return res.status(200).json({
        ok: true,
        eventId: event.id,
        companyId,
        signatureValid,
      });
    } catch (error) {
      this.logger.error('Falha ao salvar webhook Meta', error as Error);
      return res.status(200).json({ ok: true, stored: false, signatureValid });
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
    rawBody: Buffer | undefined,
    body: Record<string, unknown>,
  ): boolean {
    const appSecret =
      this.configService.get<string>('META_APP_SECRET') ||
      this.configService.get<string>('META_SECRET');

    if (!appSecret || !signature) return true;

    const payload = rawBody && rawBody.length > 0
      ? rawBody
      : Buffer.from(JSON.stringify(body));

    const expected =
      'sha256=' +
      crypto
        .createHmac('sha256', appSecret)
        .update(payload)
        .digest('hex');

    const expectedBuffer = Buffer.from(expected);
    const signatureBuffer = Buffer.from(signature);
    if (expectedBuffer.length !== signatureBuffer.length) {
      return false;
    }

    return crypto.timingSafeEqual(expectedBuffer, signatureBuffer);
  }

  private extractCompanyId(payload: Record<string, unknown>): string | null {
    const direct = payload?.['companyId'] || payload?.['company_id'];
    if (typeof direct === 'string' && direct.trim()) return direct.trim();
    return null;
  }
}
