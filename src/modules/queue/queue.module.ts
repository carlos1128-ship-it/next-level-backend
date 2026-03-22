import { DynamicModule, Logger, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import {
  WEBHOOKS_QUEUE_ENABLED,
  createRedisConnection,
  getRedisUrl,
  isRedisConfigured,
} from './queue.constants';

@Module({})
export class QueueModule {
  static register(): DynamicModule {
    const logger = new Logger(QueueModule.name);
    const redisUrl = getRedisUrl();
    const queueEnabled = isRedisConfigured();

    if (!queueEnabled) {
      logger.warn('REDIS_URL not configured. BullMQ disabled; webhooks will run inline.');
      return {
        module: QueueModule,
        providers: [{ provide: WEBHOOKS_QUEUE_ENABLED, useValue: false }],
        exports: [WEBHOOKS_QUEUE_ENABLED],
      };
    }

    return {
      module: QueueModule,
      imports: [
        BullModule.forRoot({
          connection: createRedisConnection(redisUrl),
        }),
        BullModule.registerQueue({
          name: 'webhooks_queue',
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
      providers: [{ provide: WEBHOOKS_QUEUE_ENABLED, useValue: true }],
      exports: [BullModule, WEBHOOKS_QUEUE_ENABLED],
    };
  }
}
