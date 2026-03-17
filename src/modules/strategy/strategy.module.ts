import { Module } from '@nestjs/common';
import { StrategyService } from './strategy.service';
import { StrategyController } from './strategy.controller';
import { PrismaService } from '../../prisma/prisma.service';
import { AiService } from '../ai/ai.service';
import { RagService } from '../ai/rag.service';
import { SalesService } from '../sales/sales.service';
import { InsightsService } from '../insights/insights.service';
import { WhatsappService } from '../integrations/whatsapp.service';
import { IntegrationsService } from '../integrations/integrations.service';

@Module({
  controllers: [StrategyController],
  providers: [
    StrategyService,
    PrismaService,
    AiService,
    RagService,
    SalesService,
    InsightsService,
    WhatsappService,
    IntegrationsService,
  ],
  exports: [StrategyService],
})
export class StrategyModule {}
