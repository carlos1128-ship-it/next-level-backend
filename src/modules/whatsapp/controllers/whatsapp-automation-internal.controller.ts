import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Public } from '../../../common/decorators/public.decorator';
import { WhatsappAgentConfigService } from '../services/whatsapp-agent-config.service';
import { WhatsappConnectionsService } from '../services/whatsapp-connections.service';
import { WhatsappConversationsService } from '../services/whatsapp-conversations.service';

@Public()
@Controller('internal/automation')
export class WhatsappAutomationInternalController {
  constructor(
    private readonly configService: ConfigService,
    private readonly connectionsService: WhatsappConnectionsService,
    private readonly agentConfigService: WhatsappAgentConfigService,
    private readonly conversationsService: WhatsappConversationsService,
  ) {}

  @Get('company-by-instance/:instanceName')
  async getCompanyByInstance(
    @Param('instanceName') instanceName: string,
    @Headers() headers: Record<string, string | string[] | undefined>,
  ) {
    this.assertAutomationToken(headers);
    const connection = await this.connectionsService.findByInstanceName(instanceName);

    return {
      companyId: connection?.companyId || null,
      whatsappConnectionId: connection?.id || null,
      companyName: connection?.company?.name || null,
      sector: connection?.company?.sector || null,
      segment: connection?.company?.segment || null,
      timezone: connection?.company?.timezone || 'America/Sao_Paulo',
      instanceName,
      status: connection?.status || 'not_found',
      connectionStatus: connection?.status || 'not_found',
    };
  }

  @Get('agent-config/:companyId')
  getAgentConfig(
    @Param('companyId') companyId: string,
    @Headers() headers: Record<string, string | string[] | undefined>,
  ) {
    this.assertAutomationToken(headers);
    return this.agentConfigService.get(companyId);
  }

  @Post('log-message')
  logMessage(
    @Body() payload: Record<string, unknown>,
    @Headers() headers: Record<string, string | string[] | undefined>,
  ) {
    this.assertAutomationToken(headers);
    return this.conversationsService.logAutomationMessage(payload);
  }

  @Post('log-conversation-state')
  logConversationState(
    @Body() payload: Record<string, unknown>,
    @Headers() headers: Record<string, string | string[] | undefined>,
  ) {
    this.assertAutomationToken(headers);
    return this.conversationsService.logConversationState(payload);
  }

  @Post('conversation-state')
  updateConversationState(
    @Body() payload: Record<string, unknown>,
    @Headers() headers: Record<string, string | string[] | undefined>,
  ) {
    this.assertAutomationToken(headers);
    return this.conversationsService.logConversationState(payload);
  }

  private assertAutomationToken(
    headers: Record<string, string | string[] | undefined>,
  ) {
    const expected = this.configService
      .get<string>('INTERNAL_AUTOMATION_TOKEN')
      ?.trim();

    if (!expected) {
      throw new UnauthorizedException('INTERNAL_AUTOMATION_TOKEN nao configurado');
    }

    const authHeader = this.readHeader(headers.authorization);
    const bearer = authHeader?.startsWith('Bearer ')
      ? authHeader.slice('Bearer '.length).trim()
      : null;
    const directToken =
      this.readHeader(headers['internal_automation_token']) ||
      this.readHeader(headers['x-internal-automation-token']);

    if (bearer !== expected && directToken !== expected) {
      throw new UnauthorizedException('Token interno invalido');
    }
  }

  private readHeader(value: string | string[] | undefined) {
    if (Array.isArray(value)) {
      return value[0]?.trim() || null;
    }
    return value?.trim() || null;
  }
}
