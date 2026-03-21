import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { IntegrationProvider } from '@prisma/client';
import { Queue } from 'bullmq';

@Injectable()
export class WebhookQueueService {
  constructor(
    @InjectQueue('webhooks_queue')
    private readonly queue: Queue,
  ) {}

  async enqueue(data: { eventId: string; provider: IntegrationProvider; companyId?: string | null }) {
    await this.queue.add('webhook', data, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
    });
  }
}
