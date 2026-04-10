import { Global, Module } from '@nestjs/common';
import { IntegrationsService } from './integrations.service';
import { IntegrationsController } from './integrations.controller';
import { IntegrationsOAuthController } from './integrations-oauth.controller';
import { PrismaService } from '../../prisma/prisma.service';
import { WhatsappService } from './whatsapp.service';
import { InstagramService } from './instagram.service';
import { MetaGraphService } from './meta-graph.service';
import { ShopeeScraperService } from './shopee-scraper.service';

import { DashboardModule } from '../dashboard/dashboard.module';
import { AiModule } from '../ai/ai.module';

@Global()
@Module({
  imports: [DashboardModule, AiModule],
  controllers: [IntegrationsController, IntegrationsOAuthController],
  providers: [
    IntegrationsService, 
    PrismaService, 
    WhatsappService, 
    InstagramService, 
    MetaGraphService,
    ShopeeScraperService
  ],
  exports: [
    IntegrationsService, 
    WhatsappService, 
    InstagramService, 
    MetaGraphService,
    ShopeeScraperService
  ],
})
export class IntegrationsModule {}
