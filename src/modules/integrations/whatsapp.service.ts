import { BadRequestException, Injectable } from '@nestjs/common';
import { IntegrationProvider } from '@prisma/client';
import { IntegrationsService } from './integrations.service';
import { MetaGraphService } from './meta-graph.service';

interface SendTemplateInput {
  to: string;
  template: string;
  language?: string;
  components?: Array<Record<string, unknown>>;
}

@Injectable()
export class WhatsappService {
  constructor(
    private readonly integrationsService: IntegrationsService,
    private readonly metaGraphService: MetaGraphService,
  ) {}

  async sendTextMessage(companyId: string, to: string, message: string) {
    const integration = await this.integrationsService.getActiveIntegration(
      companyId,
      IntegrationProvider.WHATSAPP,
    );

    await this.metaGraphService.requestWithRetry({
      companyId,
      method: 'POST',
      path: `${integration.externalId}/messages`,
      accessToken: integration.accessToken,
      data: {
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: message },
      },
    });

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

    await this.metaGraphService.requestWithRetry({
      companyId,
      method: 'POST',
      path: `${integration.externalId}/messages`,
      accessToken: integration.accessToken,
      data: {
        messaging_product: 'whatsapp',
        to: payload.to,
        type: 'template',
        template: {
          name: payload.template,
          language: { code: payload.language || 'pt_BR' },
          components: payload.components,
        },
      },
    });

    return { sent: true };
  }

  async discoverBusinessProfile(accessToken: string) {
    return this.metaGraphService.discoverWhatsappBusiness(accessToken);
  }
}
