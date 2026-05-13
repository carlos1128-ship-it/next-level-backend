import { Body, Controller, Headers, Post, Req, Res } from '@nestjs/common';
import { IntegrationProvider } from '@prisma/client';
import { Request, Response } from 'express';
import { Public } from '../../common/decorators/public.decorator';
import { WebhookIngestService } from '../webhooks/webhook-ingest.service';
import { MercadoLivreCryptoService } from './mercado-livre-crypto.service';
import { asRecord, asString } from './mercado-livre-utils';

@Controller('webhook/ml')
export class MercadoLivreWebhookController {
  constructor(
    private readonly webhookIngestService: WebhookIngestService,
    private readonly cryptoService: MercadoLivreCryptoService,
  ) {}

  @Public()
  @Post()
  async receive(
    @Req() req: Request & { rawBody?: Buffer },
    @Res() res: Response,
    @Headers('x-meli-signature') meliSignature: string | undefined,
    @Headers('x-webhook-signature') webhookSignature: string | undefined,
    @Headers('x-signature') signature: string | undefined,
    @Body() body: Record<string, unknown>,
  ) {
    const signatureValid = this.cryptoService.verifyWebhookSignature(
      req.rawBody,
      body,
      meliSignature || webhookSignature || signature,
    );
    if (!signatureValid) {
      return res.status(401).json({ ok: false, error: 'Assinatura Mercado Livre invalida' });
    }

    const externalId = this.extractExternalId(body);
    const { event, companyId } = await this.webhookIngestService.registerEvent(
      IntegrationProvider.MERCADOLIVRE,
      body,
      externalId,
      null,
    );

    return res.status(200).json({ ok: true, eventId: event.id, companyId });
  }

  private extractExternalId(payload: Record<string, unknown>): string | null {
    const userId = asString(payload.user_id) || asString(payload.seller_id);
    if (userId) return userId;
    const seller = asRecord(payload.seller);
    return asString(seller?.id);
  }
}
