import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { IntegrationProvider, WebhookLogStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { MercadoLivreAuthService } from './mercado-livre-auth.service';
import { MercadoLivreSyncService } from './mercado-livre-sync.service';
import { JsonRecord } from './mercado-livre.types';
import { asRecord, asString } from './mercado-livre-utils';

type WebhookQueuePayload = {
  eventId: string;
  provider: IntegrationProvider;
  companyId?: string | null;
};

@Injectable()
export class MercadoLivreWebhookService {
  private readonly logger = new Logger(MercadoLivreWebhookService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly authService: MercadoLivreAuthService,
    private readonly syncService: MercadoLivreSyncService,
  ) {}

  @OnEvent('webhooks.received')
  async handleQueuedWebhook(payload: WebhookQueuePayload) {
    if (payload.provider !== IntegrationProvider.MERCADOLIVRE) return;
    await this.processEvent(payload.eventId, payload.companyId || null);
  }

  async processEvent(eventId: string, companyIdHint?: string | null) {
    const event = await this.prisma.webhookEvent.findUnique({
      where: { id: eventId },
      select: { id: true, payload: true, companyId: true },
    });
    const payload = asRecord(event?.payload);
    if (!event || !payload) return;

    const companyId = event.companyId || companyIdHint || (await this.resolveCompanyId(payload));
    if (!companyId) {
      await this.log(event.companyId, event.id, WebhookLogStatus.FAILED, 'Empresa Mercado Livre nao localizada para webhook');
      return;
    }

    try {
      const resource = asString(payload.resource) || '';
      const topic = asString(payload.topic) || asString(payload.type) || '';
      await this.processResource(companyId, resource, topic);
      await this.prisma.webhookEvent.update({
        where: { id: event.id },
        data: { processed: true, companyId },
      });
      await this.log(companyId, event.id, WebhookLogStatus.SUCCESS, `Webhook Mercado Livre processado: ${topic || resource}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Falha ao processar webhook Mercado Livre';
      this.logger.error(message, error instanceof Error ? error.stack : undefined);
      await this.log(companyId, event.id, WebhookLogStatus.FAILED, message);
    }
  }

  private async processResource(companyId: string, resource: string, topic: string) {
    const orderId = this.matchResource(resource, /orders\/(?:v2\/)?([0-9]+)/);
    if (orderId || topic === 'orders_v2' || topic === 'orders') {
      if (orderId) await this.syncService.syncOrderById(companyId, orderId);
      return;
    }

    const questionId = this.matchResource(resource, /questions\/([0-9]+)/);
    if (questionId || topic === 'questions') {
      if (questionId) await this.syncService.syncQuestionById(companyId, questionId);
      return;
    }

    const itemId = this.matchResource(resource, /items\/([A-Z]{2,4}[0-9]+)/i);
    if (itemId || topic === 'items' || topic === 'items_prices' || topic === 'stock_locations') {
      if (itemId) await this.syncService.syncProductById(companyId, itemId.toUpperCase());
      return;
    }

    const shipmentId = this.matchResource(resource, /shipments\/([0-9]+)/);
    if (shipmentId || topic === 'shipments') {
      if (shipmentId) await this.syncService.syncShipmentById(companyId, shipmentId);
      return;
    }

    this.logger.log(`Webhook Mercado Livre recebido sem acao direta: ${topic || resource}`);
  }

  private async resolveCompanyId(payload: JsonRecord): Promise<string | null> {
    const userId = asString(payload.user_id) || asString(payload.seller_id);
    if (userId) {
      const companyId = await this.authService.findCompanyIdByMlUserId(userId);
      if (companyId) return companyId;
    }

    const seller = asRecord(payload.seller);
    const sellerId = asString(seller?.id);
    return sellerId ? this.authService.findCompanyIdByMlUserId(sellerId) : null;
  }

  private matchResource(resource: string, pattern: RegExp): string | null {
    const match = resource.match(pattern);
    return match?.[1] || null;
  }

  private async log(
    companyId: string | null | undefined,
    eventId: string,
    status: WebhookLogStatus,
    message: string,
  ) {
    await this.prisma.webhookLog.create({
      data: {
        companyId: companyId || undefined,
        provider: IntegrationProvider.MERCADOLIVRE,
        status,
        eventId,
        message,
      },
    });
  }
}
