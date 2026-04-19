import { Injectable, Logger } from '@nestjs/common';
import { IntegrationProvider, Prisma, WebhookLogStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { IntegrationsService } from '../integrations/integrations.service';
import { PlatformQueueService } from '../queue/platform-queue.service';

@Injectable()
export class WebhookIngestService {
  private readonly logger = new Logger(WebhookIngestService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly integrationsService: IntegrationsService,
    private readonly platformQueue: PlatformQueueService,
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
      await this.prisma.webhookLog.create({
        data: {
          companyId: companyId || undefined,
          provider,
          status: WebhookLogStatus.SUCCESS,
          message: 'Webhook recebido com sucesso',
          eventId: event.id,
        },
      });

      await this.platformQueue.enqueueWebhook({ eventId: event.id, provider, companyId });

      return { event, companyId };
    } catch (error) {
      await this.prisma.webhookLog
        .create({
          data: {
            companyId: companyIdHint?.trim() || undefined,
            provider,
            status: WebhookLogStatus.FAILED,
            message: (error as Error)?.message || 'Falha ao registrar webhook',
          },
        })
        .catch(() => undefined);
      this.logger.error('Falha ao registrar webhook', error as Error);
      throw error;
    }
  }
}
