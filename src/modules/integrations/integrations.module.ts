import { Global, Module } from '@nestjs/common';
import { IntegrationsService } from './integrations.service';
import { IntegrationsController } from './integrations.controller';
import { IntegrationsOAuthController } from './integrations-oauth.controller';
import { PrismaService } from '../../prisma/prisma.service';
import { WhatsappService } from './whatsapp.service';
import { InstagramService } from './instagram.service';
import { MetaGraphService } from './meta-graph.service';

@Global()
@Module({
  controllers: [IntegrationsController, IntegrationsOAuthController],
  providers: [IntegrationsService, PrismaService, WhatsappService, InstagramService, MetaGraphService],
  exports: [IntegrationsService, WhatsappService, InstagramService, MetaGraphService],
})
export class IntegrationsModule {}
