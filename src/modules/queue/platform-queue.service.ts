import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { IntegrationProvider } from '@prisma/client';
import { Queue } from 'bullmq';
import {
  PLATFORM_EVENTS_QUEUE,
  WEBHOOKS_QUEUE_ENABLED,
} from './queue.constants';

type WebhookQueuePayload = {
  eventId: string;
  provider: IntegrationProvider;
  companyId?: string | null;
};

type WhatsappMessageQueuePayload = {
  messageEventId: string;
  companyId: string;
};

@Injectable()
export class PlatformQueueService {
  private readonly logger = new Logger(PlatformQueueService.name);
  private hasWarnedInlineFallback = false;

  constructor(
    @Inject(WEBHOOKS_QUEUE_ENABLED)
    private readonly queueEnabled: boolean,
    private readonly eventEmitter: EventEmitter2,
    @Optional()
    @InjectQueue(PLATFORM_EVENTS_QUEUE)
    private readonly queue?: Queue,
  ) {}

  async enqueueWebhook(data: WebhookQueuePayload) {
    if (!this.queueEnabled || !this.queue) {
      this.logInlineFallback('queue disabled');
      this.eventEmitter.emit('webhooks.received', data);
      return;
    }

    try {
      await this.queue.add('webhook', data, {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: true,
        removeOnFail: false,
        jobId: `webhook:${data.eventId}`,
      });
    } catch (error) {
      this.logInlineFallback((error as Error)?.message || 'queue unavailable');
      this.eventEmitter.emit('webhooks.received', data);
    }
  }

  async enqueueWhatsappMessage(data: WhatsappMessageQueuePayload) {
    if (!this.queueEnabled || !this.queue) {
      this.logInlineFallback('queue disabled');
      this.eventEmitter.emit('whatsapp.message.process', data);
      return;
    }

    try {
      await this.queue.add('whatsapp-message', data, {
        attempts: 5,
        backoff: { type: 'exponential', delay: 3000 },
        removeOnComplete: true,
        removeOnFail: false,
        jobId: `whatsapp-message:${data.messageEventId}`,
      });
    } catch (error) {
      this.logInlineFallback((error as Error)?.message || 'queue unavailable');
      this.eventEmitter.emit('whatsapp.message.process', data);
    }
  }

  private logInlineFallback(reason: string) {
    if (this.hasWarnedInlineFallback) return;
    this.hasWarnedInlineFallback = true;
    this.logger.warn(`BullMQ indisponivel (${reason}). Processamento inline ativado.`);
  }
}
