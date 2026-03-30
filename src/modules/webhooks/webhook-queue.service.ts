import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { IntegrationProvider } from '@prisma/client';
import { Queue } from 'bullmq';
import { WEBHOOKS_QUEUE_ENABLED } from '../queue/queue.constants';

@Injectable()
export class WebhookQueueService {
  private readonly logger = new Logger(WebhookQueueService.name);
  private hasWarnedInlineFallback = false;

  constructor(
    @Inject(WEBHOOKS_QUEUE_ENABLED)
    private readonly queueEnabled: boolean,
    private readonly eventEmitter: EventEmitter2,
    @Optional()
    @InjectQueue('webhooks_queue')
    private readonly queue?: Queue,
  ) {}

  async enqueue(data: { eventId: string; provider: IntegrationProvider; companyId?: string | null }) {
    if (!this.queueEnabled || !this.queue) {
      this.logInlineFallback('queue disabled');
      this.eventEmitter.emit('webhooks.received', data);
      return;
    }

    try {
      await this.queue.add('webhook', data, {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
      });
    } catch (error) {
      this.logInlineFallback((error as Error)?.message || 'queue unavailable');
      this.eventEmitter.emit('webhooks.received', data);
    }
  }

  private logInlineFallback(reason: string) {
    if (this.hasWarnedInlineFallback) return;
    this.hasWarnedInlineFallback = true;
    this.logger.warn(`BullMQ unavailable (${reason}). Processing webhook inline.`);
  }
}
