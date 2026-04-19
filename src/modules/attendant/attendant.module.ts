import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AttendantService } from './attendant.service';
import { AttendantController } from './attendant.controller';
import { AttendantGateway } from './attendant.gateway';
import { AiModule } from '../ai/ai.module';
import { AuthModule } from '../auth/auth.module';
import { IntegrationsModule } from '../integrations/integrations.module';
import { AlertsModule } from '../alerts/alerts.module';
import { WhatsappRuntimeRecoveryService } from './whatsapp-runtime-recovery.service';

@Module({
  imports: [ConfigModule, AuthModule, AiModule, IntegrationsModule, AlertsModule],
  controllers: [AttendantController],
  providers: [AttendantService, AttendantGateway, WhatsappRuntimeRecoveryService],
  exports: [AttendantService],
})
export class AttendantModule {}
