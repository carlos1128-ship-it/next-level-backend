import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AttendantService } from './attendant.service';
import { AttendantController } from './attendant.controller';
import { AttendantGateway } from './attendant.gateway';
import { AiModule } from '../ai/ai.module';
import { IntegrationsModule } from '../integrations/integrations.module';
import { AlertsModule } from '../alerts/alerts.module';

@Module({
  imports: [ConfigModule, AiModule, IntegrationsModule, AlertsModule],
  controllers: [AttendantController],
  providers: [AttendantService, AttendantGateway],
  exports: [AttendantService],
})
export class AttendantModule {}
