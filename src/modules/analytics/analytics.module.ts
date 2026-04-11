import { Module } from '@nestjs/common';
import { AnalyticsService } from './analytics.service';
import { AnalyticsController } from './analytics.controller';
import { ForecastService } from './forecast.service';
import { AlertsModule } from '../alerts/alerts.module';
import { StrategyModule } from '../strategy/strategy.module';

@Module({
  imports: [AlertsModule, StrategyModule],
  controllers: [AnalyticsController],
  providers: [AnalyticsService, ForecastService],
})
export class AnalyticsModule {}
