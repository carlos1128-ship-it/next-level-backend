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
  const fallback = process.env.NODE_ENV === 'production' ? 3 : 1;
  const parsed = Number(process.env.PRISMA_CONNECT_RETRIES ?? fallback);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveRetryDelayMs(): number {
  const fallback = 1500;
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
  private readonly columnAvailabilityCache = new Map<string, boolean>();
  private readonly columnAvailabilityWarned = new Set<string>();

  async onModuleInit(): Promise<void> {
    const startTime = Date.now();
    const maxAttempts = resolveRetryCount();
    const retryDelayMs = resolveRetryDelayMs();

    this.logger.log(`Iniciando conexao com banco de dados (max ${maxAttempts} tentativas)...`);

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await this.$connect();
        await this.$queryRaw`SELECT 1`;
        const elapsed = Date.now() - startTime;
        this.logger.log(`Conexao com banco validada em ${elapsed}ms`);
        return;
      } catch (error) {
        const isLastAttempt = attempt === maxAttempts;
        const elapsed = Date.now() - startTime;

        this.logger.error(
          `Falha ao conectar no banco de dados (tentativa ${attempt}/${maxAttempts}, ${elapsed}ms)`,
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

  async hasColumn(tableName: string, columnName: string): Promise<boolean> {
    const cacheKey = `${tableName}.${columnName}`;
    const cached = this.columnAvailabilityCache.get(cacheKey);
    if (typeof cached === 'boolean') {
      return cached;
    }

    const rows = await this.$queryRaw<Array<{ present: number }>>`
      SELECT 1 AS present
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = ${tableName}
        AND column_name = ${columnName}
      LIMIT 1
    `;

    const isAvailable = rows.length > 0;
    this.columnAvailabilityCache.set(cacheKey, isAvailable);

    if (!isAvailable && !this.columnAvailabilityWarned.has(cacheKey)) {
      this.logger.warn(
        `Coluna opcional ausente no banco atual: ${cacheKey}. O app vai usar fallback compativel.`,
      );
      this.columnAvailabilityWarned.add(cacheKey);
    }

    return isAvailable;
  }
}
