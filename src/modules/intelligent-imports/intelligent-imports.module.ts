import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { ImportedMetricsController } from './imported-metrics.controller';
import { IntelligentImportAiService } from './intelligent-import-ai.service';
import { IntelligentImportsController } from './intelligent-imports.controller';
import { IntelligentImportsService } from './intelligent-imports.service';

@Module({
  imports: [AiModule],
  controllers: [IntelligentImportsController, ImportedMetricsController],
  providers: [IntelligentImportsService, IntelligentImportAiService],
  exports: [IntelligentImportsService],
})
export class IntelligentImportsModule {}
