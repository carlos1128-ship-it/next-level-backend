import { Controller, Post, Headers, Body, BadRequestException } from '@nestjs/common';
import { Public } from '../../common/decorators/public.decorator';
import { WebhooksShopifyService } from './webhooks-shopify.service';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

/**
 * Webhook Shopify: recebe eventos de pedidos e atualiza vendas.
 * POST /api/webhooks/shopify
 * Validação de origem via HMAC (header X-Shopify-Hmac-Sha256).
 * Para HMAC exato em produção, configure rawBody no bootstrap (bodyParser.raw).
 */
@Controller('webhooks/shopify')
export class ShopifyController {
  constructor(
    private readonly webhooksShopifyService: WebhooksShopifyService,
    private readonly configService: ConfigService,
  ) {}

  @Public()
  @Post()
  async handle(
    @Headers('x-shopify-hmac-sha256') hmac: string,
    @Body() body: Record<string, unknown>,
  ) {
    const secret = this.configService.get<string>('SHOPIFY_WEBHOOK_SECRET');
    if (secret && hmac) {
      const payload = JSON.stringify(body);
      const hash = crypto.createHmac('sha256', secret).update(payload).digest('base64');
      if (hash !== hmac) {
        throw new BadRequestException('Assinatura Shopify inválida');
      }
    }

    return this.webhooksShopifyService.processWebhook(body);
  }
}
