import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { IntegrationProvider } from '@prisma/client';

@Processor('webhooks_queue')
export class WebhookProcessor extends WorkerHost {
  constructor(private readonly eventEmitter: EventEmitter2) {
    super();
  }

  async process(job: Job<{ eventId: string; provider: IntegrationProvider; companyId?: string | null }>) {
    const { eventId, provider, companyId } = job.data;
    this.eventEmitter.emit('webhooks.received', { eventId, provider, companyId });
    return { ok: true };
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, err: Error) {
    // could add alerting hook here
    // eslint-disable-next-line no-console
    console.error('Webhook job failed', job.id, err.message);
  }
}
