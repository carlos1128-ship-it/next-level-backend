import { Global, Module } from '@nestjs/common';
import { IntegrationsService } from './integrations.service';
import { IntegrationsController } from './integrations.controller';
import { IntegrationsOAuthController } from './integrations-oauth.controller';
import { MetaIntegrationModule } from '../meta/meta.module';
import { InstagramService } from './instagram.service';
import { MetaGraphService } from './meta-graph.service';
import { ShopeeScraperService } from './shopee-scraper.service';
import { EvolutionController } from './evolution.controller';
import { EvolutionService } from './evolution.service';

import { DashboardModule } from '../dashboard/dashboard.module';
import { AiModule } from '../ai/ai.module';

@Global()
@Module({
  imports: [DashboardModule, AiModule, MetaIntegrationModule],
  controllers: [IntegrationsController, IntegrationsOAuthController, EvolutionController],
  providers: [
    IntegrationsService, 
    InstagramService, 
    MetaGraphService,
    ShopeeScraperService,
    EvolutionService,
  ],
  exports: [
    IntegrationsService, 
    MetaIntegrationModule,
    InstagramService, 
    MetaGraphService,
    ShopeeScraperService,
    EvolutionService,
  ],
})
export class IntegrationsModule {}
