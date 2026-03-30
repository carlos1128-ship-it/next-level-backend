import { Module } from '@nestjs/common';
import { AttendantService } from './attendant.service';
import { AttendantController } from './attendant.controller';
import { PrismaService } from '../../prisma/prisma.service';
import { AiModule } from '../ai/ai.module';
import { IntegrationsModule } from '../integrations/integrations.module';
import { AlertsModule } from '../alerts/alerts.module';

@Module({
  imports: [AiModule, IntegrationsModule, AlertsModule],
  controllers: [AttendantController],
  providers: [AttendantService, PrismaService],
  exports: [AttendantService],
})
export class AttendantModule {}
