import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../../prisma/prisma.module';
import { AgentConfigController } from './controllers/agent-config.controller';
import { WhatsappAutomationInternalController } from './controllers/whatsapp-automation-internal.controller';
import { WhatsappConnectionsController } from './controllers/whatsapp-connections.controller';
import { WhatsappAgentConfigService } from './services/whatsapp-agent-config.service';
import { WhatsappConnectionsService } from './services/whatsapp-connections.service';
import { WhatsappConversationsService } from './services/whatsapp-conversations.service';
import { WhatsappProviderEvolutionService } from './services/whatsapp-provider-evolution.service';

@Module({
  imports: [ConfigModule, PrismaModule],
  controllers: [
    WhatsappConnectionsController,
    AgentConfigController,
    WhatsappAutomationInternalController,
  ],
  providers: [
    WhatsappProviderEvolutionService,
    WhatsappConnectionsService,
    WhatsappAgentConfigService,
    WhatsappConversationsService,
  ],
  exports: [
    WhatsappProviderEvolutionService,
    WhatsappConnectionsService,
    WhatsappConversationsService,
    WhatsappAgentConfigService,
  ],
})
export class WhatsappModule {}
