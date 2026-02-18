import { Module } from '@nestjs/common';
import { AiController } from './ai.controller';
import { AiAnalyzeController } from './ai-analyze.controller';
import { AiService } from './ai.service';
import { RagService } from './rag.service';
import { SalesModule } from '../sales/sales.module';
import { InsightsModule } from '../insights/insights.module';

@Module({
  imports: [SalesModule, InsightsModule],
  controllers: [AiController, AiAnalyzeController],
  providers: [AiService, RagService],
  exports: [AiService, RagService],
})
export class AiModule {}
