import { Module } from '@nestjs/common';
import { ShopifyController } from './shopify.controller';
import { WebhooksController } from './webhooks.controller';
import { WebhooksShopifyService } from './webhooks-shopify.service';
import { WebhooksMetaService } from './webhooks-meta.service';
import { WebhookIngestService } from './webhook-ingest.service';
import { IntegrationsModule } from '../integrations/integrations.module';

@Module({
  imports: [IntegrationsModule],
  controllers: [ShopifyController, WebhooksController],
  providers: [
    WebhooksShopifyService,
    WebhooksMetaService,
    WebhookIngestService,
  ],
  exports: [WebhooksShopifyService, WebhooksMetaService],
})
export class WebhooksModule {}
