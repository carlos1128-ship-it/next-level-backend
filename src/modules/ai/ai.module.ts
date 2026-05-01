import { Module } from '@nestjs/common';
import { AiController } from './ai.controller';
import { AiAnalyzeController } from './ai-analyze.controller';
import { AiBusinessController } from './ai-business.controller';
import { AiService } from './ai.service';
import { AiAlertService } from './ai-alert.service';
import { AiBrainService } from './ai-brain.service';
import { AiRecommendationService } from './ai-recommendation.service';
import { AiWhatsAppAnalysisService } from './ai-whatsapp-analysis.service';
import { AnalyticsEngineService } from './analytics-engine.service';
import { BusinessContextService } from './business-context.service';
import { BusinessMemoryService } from './business-memory.service';
import { InsightGenerationService } from './insight-generation.service';
import { RagService } from './rag.service';
import { SalesModule } from '../sales/sales.module';
import { InsightsModule } from '../insights/insights.module';
import { DashboardModule } from '../dashboard/dashboard.module';
import { UsageModule } from '../usage/usage.module';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';

@Module({
  imports: [SalesModule, InsightsModule, DashboardModule, UsageModule],
  controllers: [AiController, AiAnalyzeController, AiBusinessController, ChatController],
  providers: [
    AiService,
    RagService,
    ChatService,
    AnalyticsEngineService,
    BusinessContextService,
    AiBrainService,
    InsightGenerationService,
    AiAlertService,
    AiRecommendationService,
    BusinessMemoryService,
    AiWhatsAppAnalysisService,
  ],
  exports: [
    AiService,
    RagService,
    ChatService,
    AnalyticsEngineService,
    BusinessContextService,
    AiBrainService,
    InsightGenerationService,
    AiAlertService,
    AiRecommendationService,
    BusinessMemoryService,
    AiWhatsAppAnalysisService,
  ],
})
export class AiModule {}
