import { Module } from '@nestjs/common';
import { AnalysisService } from './analysis.service';
import { AlertsModule } from '../alerts/alerts.module';

@Module({
  imports: [AlertsModule],
  providers: [AnalysisService],
})
export class AnalysisModule {}
