import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { IntegrationProvider, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { IntegrationsService } from '../integrations/integrations.service';

@Injectable()
export class WebhookIngestService {
  private readonly logger = new Logger(WebhookIngestService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly integrationsService: IntegrationsService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async registerEvent(
    provider: IntegrationProvider,
    payload: Record<string, unknown>,
    externalId?: string | null,
    companyIdHint?: string | null,
  ) {
    try {
      const companyId =
        companyIdHint?.trim() ||
        (await this.integrationsService.findCompanyIdByExternalId(
          provider,
          externalId,
        ));

      const event = await this.prisma.webhookEvent.create({
        data: {
          provider,
          payload: payload as Prisma.InputJsonValue,
          processed: false,
          companyId: companyId || undefined,
        },
      });

      this.eventEmitter.emit('webhooks.received', {
        eventId: event.id,
        provider,
        companyId,
        externalId,
      });

      return { event, companyId };
    } catch (error) {
      this.logger.error('Falha ao registrar webhook', error as Error);
      throw error;
    }
  }
}
