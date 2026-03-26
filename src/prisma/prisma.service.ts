import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

function normalizeDatabaseUrl(raw: string | undefined): string | undefined {
  if (!raw) return raw;

  try {
    const url = new URL(raw);
    const isPostgres = ['postgres:', 'postgresql:'].includes(url.protocol);
    const isLocalHost = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);

    if (!isPostgres || isLocalHost) {
      return raw;
    }

    if (!url.searchParams.has('sslmode')) {
      url.searchParams.set('sslmode', 'require');
    }

    if (!url.searchParams.has('connect_timeout')) {
      url.searchParams.set('connect_timeout', '15');
    }

    return url.toString();
  } catch {
    return raw;
  }
}

function resolveRetryCount(): number {
  const fallback = process.env.NODE_ENV === 'production' ? 5 : 1;
  const parsed = Number(process.env.PRISMA_CONNECT_RETRIES ?? fallback);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveRetryDelayMs(): number {
  const fallback = 3000;
  const parsed = Number(process.env.PRISMA_CONNECT_RETRY_DELAY_MS ?? fallback);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const normalizedDatabaseUrl = normalizeDatabaseUrl(process.env.DATABASE_URL);
if (normalizedDatabaseUrl && normalizedDatabaseUrl !== process.env.DATABASE_URL) {
  process.env.DATABASE_URL = normalizedDatabaseUrl;
}

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  async onModuleInit(): Promise<void> {
    const maxAttempts = resolveRetryCount();
    const retryDelayMs = resolveRetryDelayMs();

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await this.$connect();
        await this.$queryRaw`SELECT 1`;
        this.logger.log('Conexao com banco validada no startup');
        return;
      } catch (error) {
        const isLastAttempt = attempt === maxAttempts;

        this.logger.error(
          `Falha ao conectar no banco de dados (tentativa ${attempt}/${maxAttempts})`,
          error as Error,
        );

        if (isLastAttempt) {
          throw error;
        }

        await delay(retryDelayMs);
      }
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
