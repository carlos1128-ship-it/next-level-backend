import { Module } from '@nestjs/common';
import { ShopifyController } from './shopify.controller';
import { WebhooksController } from './webhooks.controller';
import { WebhooksShopifyService } from './webhooks-shopify.service';
import { WebhooksMetaService } from './webhooks-meta.service';
import { WebhookIngestService } from './webhook-ingest.service';
import { IntegrationsModule } from '../integrations/integrations.module';
import { QueueModule } from '../queue/queue.module';
import { WebhookProcessor } from './webhook-processor';
import { WebhookQueueService } from './webhook-queue.service';

@Module({
  imports: [IntegrationsModule, QueueModule],
  controllers: [ShopifyController, WebhooksController],
  providers: [
    WebhooksShopifyService,
    WebhooksMetaService,
    WebhookIngestService,
    WebhookProcessor,
    WebhookQueueService,
  ],
  exports: [WebhooksShopifyService, WebhooksMetaService],
})
export class WebhooksModule {}
