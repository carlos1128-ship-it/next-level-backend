import { Module } from '@nestjs/common';
import { IntegrationsService } from './integrations.service';
import { IntegrationsController } from './integrations.controller';
import { PrismaService } from '../../prisma/prisma.service';
import { WhatsappService } from './whatsapp.service';

@Module({
  controllers: [IntegrationsController],
  providers: [IntegrationsService, PrismaService, WhatsappService],
  exports: [IntegrationsService, WhatsappService],
})
export class IntegrationsModule {}
