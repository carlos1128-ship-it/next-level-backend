import { Module } from '@nestjs/common';
import { AnalyticsService } from './analytics.service';
import { AnalyticsController } from './analytics.controller';
import { PrismaService } from '../../prisma/prisma.service';
import { ForecastService } from './forecast.service';
import { AlertsModule } from '../alerts/alerts.module';

@Module({
  imports: [AlertsModule],
  controllers: [AnalyticsController],
  providers: [AnalyticsService, ForecastService, PrismaService],
})
export class AnalyticsModule {}
