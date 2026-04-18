import { Global, Module } from '@nestjs/common';
import { IntegrationsService } from './integrations.service';
import { IntegrationsController } from './integrations.controller';
import { IntegrationsOAuthController } from './integrations-oauth.controller';
import { MetaIntegrationModule } from '../meta/meta.module';
import { InstagramService } from './instagram.service';
import { MetaGraphService } from './meta-graph.service';
import { ShopeeScraperService } from './shopee-scraper.service';
import { WppconnectService } from './wppconnect.service';

import { DashboardModule } from '../dashboard/dashboard.module';
import { AiModule } from '../ai/ai.module';

@Global()
@Module({
  imports: [DashboardModule, AiModule, MetaIntegrationModule],
  controllers: [IntegrationsController, IntegrationsOAuthController],
  providers: [
    IntegrationsService, 
    InstagramService, 
    MetaGraphService,
    ShopeeScraperService,
    WppconnectService,
  ],
  exports: [
    IntegrationsService, 
    MetaIntegrationModule,
    InstagramService, 
    MetaGraphService,
    ShopeeScraperService,
    WppconnectService,
  ],
})
export class IntegrationsModule {}
