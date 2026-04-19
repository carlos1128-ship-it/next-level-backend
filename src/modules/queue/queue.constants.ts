export const WEBHOOKS_QUEUE_ENABLED = 'WEBHOOKS_QUEUE_ENABLED';
export const PLATFORM_EVENTS_QUEUE = 'platform_events_queue';

export function getRedisUrl() {
  return process.env.REDIS_URL?.trim() || '';
}

export function isRedisConfigured() {
  return Boolean(getRedisUrl());
}

export function createRedisConnection(url: string) {
  const parsed = new URL(url);
  const database = parsed.pathname.replace('/', '');

  return {
    url,
    host: parsed.hostname,
    port: Number(parsed.port || 6379),
    username: parsed.username || undefined,
    password: parsed.password || undefined,
    db: database ? Number(database) : 0,
    tls: parsed.protocol === 'rediss:' ? {} : undefined,
  };
}
