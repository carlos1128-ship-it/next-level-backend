import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../../prisma/prisma.module';
import { UsageModule } from '../usage/usage.module';
import { AgentConfigController } from './controllers/agent-config.controller';
import { WhatsappAutomationInternalController } from './controllers/whatsapp-automation-internal.controller';
import { WhatsappConnectionsController } from './controllers/whatsapp-connections.controller';
import { WhatsappConversationsController } from './controllers/whatsapp-conversations.controller';
import { WhatsappAgentConfigService } from './services/whatsapp-agent-config.service';
import { WhatsappConnectionsService } from './services/whatsapp-connections.service';
import { WhatsappConversationsService } from './services/whatsapp-conversations.service';
import { WhatsappProviderEvolutionService } from './services/whatsapp-provider-evolution.service';
import { EvolutionApiService } from './services/evolution-api.service';

@Module({
  imports: [ConfigModule, PrismaModule, UsageModule],
  controllers: [
    WhatsappConnectionsController,
    WhatsappConversationsController,
    AgentConfigController,
    WhatsappAutomationInternalController,
  ],
  providers: [
    WhatsappProviderEvolutionService,
    EvolutionApiService,
    WhatsappConnectionsService,
    WhatsappAgentConfigService,
    WhatsappConversationsService,
  ],
  exports: [
    WhatsappProviderEvolutionService,
    EvolutionApiService,
    WhatsappConnectionsService,
    WhatsappConversationsService,
    WhatsappAgentConfigService,
  ],
})
export class WhatsappModule {}
