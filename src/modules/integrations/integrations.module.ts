import { Module } from '@nestjs/common';
import { IntegrationsService } from './integrations.service';
import { IntegrationsController } from './integrations.controller';
import { PrismaService } from '../../prisma/prisma.service';
import { WhatsappService } from './whatsapp.service';
import { MetaGraphService } from './meta-graph.service';

@Module({
  controllers: [IntegrationsController],
  providers: [IntegrationsService, PrismaService, WhatsappService, MetaGraphService],
  exports: [IntegrationsService, WhatsappService, MetaGraphService],
})
export class IntegrationsModule {}
