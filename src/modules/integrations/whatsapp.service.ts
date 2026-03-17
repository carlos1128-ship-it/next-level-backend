import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IntegrationProvider } from '@prisma/client';
import axios from 'axios';
import { IntegrationsService } from './integrations.service';

interface SendTemplateInput {
  to: string;
  template: string;
  language?: string;
  components?: Array<Record<string, unknown>>;
}

@Injectable()
export class WhatsappService {
  private readonly logger = new Logger(WhatsappService.name);
  private readonly graphVersion: string;

  constructor(
    private readonly integrationsService: IntegrationsService,
    private readonly configService: ConfigService,
  ) {
    const version = this.configService.get<string>('META_GRAPH_VERSION') || '20.0';
    this.graphVersion = version.replace(/^v/i, '') || '20.0';
  }

  async sendTextMessage(companyId: string, to: string, message: string) {
    const integration = await this.integrationsService.getActiveIntegration(
      companyId,
      IntegrationProvider.WHATSAPP,
    );

    const url = `https://graph.facebook.com/v${this.graphVersion}/${integration.externalId}/messages`;

    await axios.post(
      url,
      {
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: message },
      },
      {
        headers: {
          Authorization: `Bearer ${integration.accessToken}`,
        },
      },
    );

    return { sent: true };
  }

  async sendTemplateMessage(
    companyId: string,
    payload: SendTemplateInput,
  ) {
    const integration = await this.integrationsService.getActiveIntegration(
      companyId,
      IntegrationProvider.WHATSAPP,
    );

    if (!payload.template) {
      throw new BadRequestException('template obrigatorio');
    }

    const url = `https://graph.facebook.com/v${this.graphVersion}/${integration.externalId}/messages`;

    await axios.post(
      url,
      {
        messaging_product: 'whatsapp',
        to: payload.to,
        type: 'template',
        template: {
          name: payload.template,
          language: { code: payload.language || 'pt_BR' },
          components: payload.components,
        },
      },
      {
        headers: {
          Authorization: `Bearer ${integration.accessToken}`,
        },
      },
    );

    return { sent: true };
  }
}
