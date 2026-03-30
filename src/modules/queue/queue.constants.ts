export const WEBHOOKS_QUEUE_ENABLED = 'WEBHOOKS_QUEUE_ENABLED';

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
    host: parsed.hostname,
    port: Number(parsed.port || 6379),
    username: parsed.username || undefined,
    password: parsed.password || undefined,
    db: database ? Number(database) : 0,
    tls: parsed.protocol === 'rediss:' ? {} : undefined,
  };
}
