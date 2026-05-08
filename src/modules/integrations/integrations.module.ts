import { Global, Module } from '@nestjs/common';
import { IntegrationsService } from './integrations.service';
import { IntegrationsController } from './integrations.controller';
import { IntegrationsOAuthController } from './integrations-oauth.controller';
import { MetaIntegrationModule } from '../meta/meta.module';
import { InstagramService } from './instagram.service';
import { InstagramController } from './instagram.controller';
import { InstagramWebhookController } from './instagram-webhook.controller';
import { InstagramWebhookService } from './instagram-webhook.service';
import { InstagramMessageProcessorService } from './instagram-message-processor.service';
import { InstagramSendService } from './instagram-send.service';
import { InstagramIntegrationService } from './instagram-integration.service';
import { AttendantConversationsController } from './attendant-conversations.controller';
import { MetaGraphService } from './meta-graph.service';
import { ShopeeScraperService } from './shopee-scraper.service';
import { EvolutionController } from './evolution.controller';
import { EvolutionService } from './evolution.service';

import { DashboardModule } from '../dashboard/dashboard.module';
import { AiModule } from '../ai/ai.module';
import { AlertsModule } from '../alerts/alerts.module';
import { AttendantActionsModule } from '../attendant-actions/attendant-actions.module';

@Global()
@Module({
  imports: [
    DashboardModule,
    AiModule,
    AlertsModule,
    MetaIntegrationModule,
    AttendantActionsModule,
  ],
  controllers: [
    IntegrationsController,
    IntegrationsOAuthController,
    EvolutionController,
    InstagramController,
    InstagramWebhookController,
    AttendantConversationsController,
  ],
  providers: [
    IntegrationsService, 
    InstagramService, 
    InstagramWebhookService,
    InstagramMessageProcessorService,
    InstagramSendService,
    InstagramIntegrationService,
    MetaGraphService,
    ShopeeScraperService,
    EvolutionService,
  ],
  exports: [
    IntegrationsService, 
    MetaIntegrationModule,
    InstagramService, 
    InstagramWebhookService,
    InstagramMessageProcessorService,
    InstagramSendService,
    InstagramIntegrationService,
    MetaGraphService,
    ShopeeScraperService,
    EvolutionService,
  ],
})
export class IntegrationsModule {}
