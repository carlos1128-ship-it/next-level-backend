import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Job } from 'bullmq';
import { PLATFORM_EVENTS_QUEUE } from './queue.constants';

type PlatformQueueJob =
  | {
      eventId: string;
      provider: string;
      companyId?: string | null;
    }
  | {
      messageEventId: string;
      companyId: string;
    };

@Processor(PLATFORM_EVENTS_QUEUE)
export class PlatformEventProcessor extends WorkerHost {
  private readonly logger = new Logger(PlatformEventProcessor.name);

  constructor(private readonly eventEmitter: EventEmitter2) {
    super();
  }

  async process(job: Job<PlatformQueueJob>) {
    if (job.name === 'webhook') {
      this.eventEmitter.emit('webhooks.received', job.data);
      return { ok: true };
    }

    if (job.name === 'whatsapp-message') {
      this.eventEmitter.emit('whatsapp.message.process', job.data);
      return { ok: true };
    }

    this.logger.warn(`Job desconhecido ignorado: ${job.name}`);
    return { ok: true, ignored: true };
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, error: Error) {
    this.logger.error(`Falha no job ${job.name}:${job.id}`, error.stack);
  }
}
