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
import { isRedisConfigured } from '../queue/queue.constants';

const queueEnabled = isRedisConfigured();

@Module({
  imports: [IntegrationsModule, QueueModule.register()],
  controllers: [ShopifyController, WebhooksController],
  providers: [
    WebhooksShopifyService,
    WebhooksMetaService,
    WebhookIngestService,
    WebhookQueueService,
    ...(queueEnabled ? [WebhookProcessor] : []),
  ],
  exports: [WebhooksShopifyService, WebhooksMetaService],
})
export class WebhooksModule {}
