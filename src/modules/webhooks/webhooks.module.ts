import { Module } from '@nestjs/common';
import { ShopifyController } from './shopify.controller';
import { MetaController } from './meta.controller';
import { WebhooksShopifyService } from './webhooks-shopify.service';
import { WebhooksMetaService } from './webhooks-meta.service';

@Module({
  controllers: [ShopifyController, MetaController],
  providers: [WebhooksShopifyService, WebhooksMetaService],
  exports: [WebhooksShopifyService, WebhooksMetaService],
})
export class WebhooksModule {}
