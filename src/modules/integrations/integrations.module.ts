import { Global, Module } from '@nestjs/common';
import { IntegrationsService } from './integrations.service';
import { IntegrationsController } from './integrations.controller';
import { IntegrationsOAuthController } from './integrations-oauth.controller';
import { PrismaService } from '../../prisma/prisma.service';
import { WhatsappService } from './whatsapp.service';
import { MetaGraphService } from './meta-graph.service';

@Global()
@Module({
  controllers: [IntegrationsController, IntegrationsOAuthController],
  providers: [IntegrationsService, PrismaService, WhatsappService, MetaGraphService],
  exports: [IntegrationsService, WhatsappService, MetaGraphService],
})
export class IntegrationsModule {}
