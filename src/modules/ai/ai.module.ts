import { Module } from '@nestjs/common';
import { AiController } from './ai.controller';
import { AiAnalyzeController } from './ai-analyze.controller';
import { AiService } from './ai.service';
import { RagService } from './rag.service';
import { SalesModule } from '../sales/sales.module';
import { InsightsModule } from '../insights/insights.module';
import { DashboardModule } from '../dashboard/dashboard.module';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';

@Module({
  imports: [SalesModule, InsightsModule, DashboardModule],
  controllers: [AiController, AiAnalyzeController, ChatController],
  providers: [AiService, RagService, ChatService],
  exports: [AiService, RagService, ChatService],
})
export class AiModule {}
