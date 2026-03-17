import { Module } from '@nestjs/common';
import { AnalysisService } from './analysis.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AlertsService } from '../alerts/alerts.service';

@Module({
  providers: [AnalysisService, PrismaService, AlertsService],
})
export class AnalysisModule {}
