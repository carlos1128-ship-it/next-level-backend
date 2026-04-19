import { DynamicModule, Global, Logger, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import {
  PLATFORM_EVENTS_QUEUE,
  WEBHOOKS_QUEUE_ENABLED,
  createRedisConnection,
  getRedisUrl,
  isRedisConfigured,
} from './queue.constants';
import { PlatformEventProcessor } from './platform-event.processor';
import { PlatformQueueService } from './platform-queue.service';

@Global()
@Module({})
export class QueueModule {
  static register(): DynamicModule {
    const logger = new Logger(QueueModule.name);
    const queueEnabled = isRedisConfigured();

    if (!queueEnabled) {
      logger.warn('REDIS_URL not configured. BullMQ disabled; eventos da plataforma rodarao inline.');
      return {
        module: QueueModule,
        providers: [
          { provide: WEBHOOKS_QUEUE_ENABLED, useValue: false },
          PlatformQueueService,
        ],
        exports: [WEBHOOKS_QUEUE_ENABLED, PlatformQueueService],
      };
    }

    const redisUrl = getRedisUrl();

    return {
      module: QueueModule,
      imports: [
        BullModule.forRoot({
          connection: createRedisConnection(redisUrl),
        }),
        BullModule.registerQueue({
          name: PLATFORM_EVENTS_QUEUE,
          defaultJobOptions: {
            attempts: 3,
            backoff: {
              type: 'exponential',
              delay: 2000,
            },
            removeOnComplete: true,
            removeOnFail: false,
          },
        }),
      ],
      providers: [
        { provide: WEBHOOKS_QUEUE_ENABLED, useValue: true },
        PlatformQueueService,
        PlatformEventProcessor,
      ],
      exports: [BullModule, WEBHOOKS_QUEUE_ENABLED, PlatformQueueService],
    };
  }
}
