import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { WhatsappController } from './whatsapp.controller';
import { WhatsappService } from './whatsapp.service';
import { WhatsappProcessor } from './whatsapp.processor';
import { PrismaService } from '../../prisma/prisma.service';
import { AiModule } from '../ai/ai.module';

@Module({
  imports: [
    BullModule.registerQueue({
      name: 'whatsapp-queue',
    }),
    AiModule,
  ],
  controllers: [WhatsappController],
  providers: [WhatsappService, WhatsappProcessor, PrismaService],
  exports: [WhatsappService],
})
export class WhatsappModule {}
