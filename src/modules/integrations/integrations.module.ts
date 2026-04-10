import { Global, Module } from '@nestjs/common';
import { IntegrationsService } from './integrations.service';
import { IntegrationsController } from './integrations.controller';
import { IntegrationsOAuthController } from './integrations-oauth.controller';
import { PrismaService } from '../../prisma/prisma.service';
import { WhatsappModule } from '../whatsapp/whatsapp.module';
import { InstagramService } from './instagram.service';
import { MetaGraphService } from './meta-graph.service';
import { ShopeeScraperService } from './shopee-scraper.service';

import { DashboardModule } from '../dashboard/dashboard.module';
import { AiModule } from '../ai/ai.module';

@Global()
@Module({
  imports: [DashboardModule, AiModule, WhatsappModule],
  controllers: [IntegrationsController, IntegrationsOAuthController],
  providers: [
    IntegrationsService, 
    PrismaService, 
    InstagramService, 
    MetaGraphService,
    ShopeeScraperService
  ],
  exports: [
    IntegrationsService, 
    WhatsappModule,
    InstagramService, 
    MetaGraphService,
    ShopeeScraperService
  ],
})
export class IntegrationsModule {}
