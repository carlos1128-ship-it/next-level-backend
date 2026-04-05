import { Injectable } from '@nestjs/common';
import { IntegrationProvider } from '@prisma/client';
import { IntegrationsService } from './integrations.service';
import { MetaGraphService } from './meta-graph.service';

@Injectable()
export class InstagramService {
  constructor(
    private readonly integrationsService: IntegrationsService,
    private readonly metaGraphService: MetaGraphService,
  ) {}

  async sendDm(companyId: string, recipientId: string, message: string) {
    const integration = await this.integrationsService.getActiveIntegration(
      companyId,
      IntegrationProvider.INSTAGRAM,
    );

    await this.metaGraphService.requestWithRetry({
      companyId,
      method: 'POST',
      path: `${integration.externalId}/messages`,
      accessToken: integration.accessToken,
      data: {
        messaging_product: 'instagram',
        recipient: { id: recipientId },
        message: { text: message },
      },
    });

    return { sent: true };
  }
}
