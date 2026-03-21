import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

function createRedisConnection(url: string) {
  const parsed = new URL(url);
  const database = parsed.pathname.replace('/', '');

  return {
    host: parsed.hostname,
    port: Number(parsed.port || 6379),
    username: parsed.username || undefined,
    password: parsed.password || undefined,
    db: database ? Number(database) : 0,
    tls: parsed.protocol === 'rediss:' ? {} : undefined,
  };
}

@Module({
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
  exports: [BullModule],
})
export class QueueModule {}
