import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ActorType, Plan, Prisma } from '@prisma/client';
import Redis from 'ioredis';
import { PrismaService } from '../../prisma/prisma.service';
import { UpdateQuotaDto } from './dto/update-quota.dto';

type HealthStatus = 'up' | 'down' | 'unknown';

@Injectable()
export class AdminService implements OnModuleDestroy {
  private readonly redis?: Redis;
  private readonly redisEnabled: boolean;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {
    const redisUrl = this.configService.get<string>('REDIS_URL')?.trim();
    this.redisEnabled = Boolean(redisUrl);

    if (redisUrl) {
      this.redis = new Redis(redisUrl, {
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        connectTimeout: 2000,
        enableOfflineQueue: false,
        retryStrategy: () => null,
      });
      this.redis.on('error', () => undefined);
    }
  }

  async getHealth() {
    const [database, redis, aiLatencySample, apiLogs, integrations] = await Promise.all([
      this.checkDatabase(),
      this.checkRedis(),
      this.prisma.apiLog.findMany({
        where: {
          OR: [
            { path: { contains: '/ai' } },
            { path: { contains: '/chat' } },
            { path: { contains: '/attendant' } },
          ],
        },
        orderBy: { createdAt: 'desc' },
        take: 10,
      }),
      this.prisma.apiLog.findMany({
        orderBy: { createdAt: 'desc' },
        take: 300,
      }),
      this.prisma.integration.findMany({
        select: { provider: true, status: true },
      }),
    ]);

    const avgAiLatencyMs = aiLatencySample.length
      ? Math.round(
          aiLatencySample.reduce((sum, log) => sum + log.responseTime, 0) / aiLatencySample.length,
        )
      : 0;

    const timeline = this.buildTimeline(apiLogs);
    const lastErrorRate = this.computeErrorRate(apiLogs);
    const providerStatus = {
      meta: this.resolveProviderStatus(integrations, ['WHATSAPP', 'INSTAGRAM']),
      mercadoLivre: this.resolveProviderStatus(integrations, ['MERCADOLIVRE']),
      gemini: this.configService.get<string>('GEMINI_API_KEY') ? 'configured' : 'missing',
      openai: this.configService.get<string>('OPENAI_API_KEY') ? 'configured' : 'missing',
    };

    return {
      services: {
        database,
        redis,
        ai: {
          status: avgAiLatencyMs > 0 ? 'up' : 'unknown',
          avgLatencyMs: avgAiLatencyMs,
        },
      },
      providers: providerStatus,
      requestTimeline: timeline,
      successVsFailure: {
        success: apiLogs.filter((log) => log.statusCode < 400).length,
        failure: apiLogs.filter((log) => log.statusCode >= 400).length,
        errorRateLastWindow: lastErrorRate,
      },
    };
  }

  async getUsageStats() {
    const quotas = await this.prisma.usageQuota.findMany({
      include: {
        company: {
          select: { id: true, name: true, createdAt: true },
        },
      },
      orderBy: { updatedAt: 'desc' },
    });

    const planPrice: Record<Plan, number> = {
      COMUM: 0,
      PRO: 297,
      ENTERPRISE: 997,
    };
    const tokenCostPerThousand = 0.02;

    const byCompany = quotas.map((quota) => {
      const revenue = planPrice[quota.currentTier] || 0;
      const aiCost = Number(((quota.llmTokensUsed / 1000) * tokenCostPerThousand).toFixed(2));
      const profitEstimate = Number((revenue - aiCost).toFixed(2));

      return {
        companyId: quota.companyId,
        companyName: quota.company.name,
        currentTier: quota.currentTier,
        llmTokensUsed: quota.llmTokensUsed,
        whatsappMessagesSent: quota.whatsappMessagesSent,
        billingCycleEnd: quota.billingCycleEnd,
        monthlyRevenue: revenue,
        aiCostEstimate: aiCost,
        profitEstimate,
      };
    });

    const totals = byCompany.reduce(
      (acc, item) => {
        acc.totalTokens += item.llmTokensUsed;
        acc.totalMessages += item.whatsappMessagesSent;
        acc.monthlyRevenue += item.monthlyRevenue;
        acc.aiCostEstimate += item.aiCostEstimate;
        acc.estimatedProfit += item.profitEstimate;
        return acc;
      },
      {
        totalTokens: 0,
        totalMessages: 0,
        monthlyRevenue: 0,
        aiCostEstimate: 0,
        estimatedProfit: 0,
      },
    );

    return {
      totals: {
        totalTokens: totals.totalTokens,
        totalMessages: totals.totalMessages,
        monthlyRevenue: Number(totals.monthlyRevenue.toFixed(2)),
        aiCostEstimate: Number(totals.aiCostEstimate.toFixed(2)),
        estimatedProfit: Number(totals.estimatedProfit.toFixed(2)),
      },
      companies: byCompany,
    };
  }

  async getErrorLogs() {
    return this.prisma.apiLog.findMany({
      where: { statusCode: { gte: 400 } },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: {
        company: {
          select: { id: true, name: true },
        },
      },
    });
  }

  async getAuditFeed() {
    return this.prisma.auditTrail.findMany({
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: {
        company: {
          select: { id: true, name: true },
        },
      },
    });
  }

  async listQuotas() {
    const quotas = await this.prisma.usageQuota.findMany({
      include: {
        company: {
          select: { id: true, name: true, sector: true },
        },
      },
      orderBy: { updatedAt: 'desc' },
    });

    return quotas;
  }

  async resetQuota(companyId: string, actorId?: string) {
    const quota = await this.ensureQuota(companyId);
    const updated = await this.prisma.usageQuota.update({
      where: { id: quota.id },
      data: {
        llmTokensUsed: 0,
        whatsappMessagesSent: 0,
        billingCycleEnd: this.addDays(new Date(), 30),
      },
    });

    await this.logAdminAction(companyId, actorId, 'admin.quota.reset', {
      quotaId: updated.id,
    });

    return updated;
  }

  async updateQuota(companyId: string, dto: UpdateQuotaDto, actorId?: string) {
    const quota = await this.ensureQuota(companyId);
    const updated = await this.prisma.usageQuota.update({
      where: { id: quota.id },
      data: {
        currentTier: dto.currentTier,
        llmTokensUsed: dto.llmTokensUsed,
        whatsappMessagesSent: dto.whatsappMessagesSent,
        billingCycleEnd: dto.billingCycleEnd ? new Date(dto.billingCycleEnd) : undefined,
      },
    });

    await this.logAdminAction(companyId, actorId, 'admin.quota.update', dto as Prisma.InputJsonValue);
    return updated;
  }

  private async ensureQuota(companyId: string) {
    return this.prisma.usageQuota.upsert({
      where: { companyId },
      update: {},
      create: {
        companyId,
        currentTier: Plan.COMUM,
        billingCycleEnd: this.addDays(new Date(), 30),
      },
    });
  }

  private async logAdminAction(
    companyId: string | null,
    actorId: string | undefined,
    action: string,
    details?: Prisma.InputJsonValue,
  ) {
    await this.prisma.auditTrail.create({
      data: {
        companyId: companyId || undefined,
        actorId,
        actorType: actorId ? ActorType.HUMAN : ActorType.SYSTEM,
        action,
        details,
      },
    });
  }

  private async checkDatabase(): Promise<{ status: HealthStatus; latencyMs: number }> {
    const start = Date.now();
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return {
        status: 'up',
        latencyMs: Date.now() - start,
      };
    } catch {
      return {
        status: 'down',
        latencyMs: Date.now() - start,
      };
    }
  }

  private async checkRedis(): Promise<{ status: HealthStatus; latencyMs: number }> {
    if (!this.redisEnabled || !this.redis) {
      return {
        status: 'unknown',
        latencyMs: 0,
      };
    }

    const start = Date.now();
    try {
      if (this.redis.status === 'wait') {
        await this.redis.connect();
      }
      await this.redis.ping();
      return {
        status: 'up',
        latencyMs: Date.now() - start,
      };
    } catch {
      return {
        status: 'down',
        latencyMs: Date.now() - start,
      };
    }
  }

  private buildTimeline(apiLogs: Array<{ createdAt: Date; responseTime: number; statusCode: number }>) {
    const buckets = new Map<
      string,
      {
        timestamp: number;
        label: string;
        responseTimeSum: number;
        total: number;
        success: number;
        failure: number;
      }
    >();

    for (const log of apiLogs) {
      const date = new Date(log.createdAt);
      const bucketDate = new Date(date);
      bucketDate.setMinutes(Math.floor(bucketDate.getMinutes() / 10) * 10, 0, 0);
      const key = bucketDate.toISOString();
      const label = `${bucketDate.getHours().toString().padStart(2, '0')}:${bucketDate
        .getMinutes()
        .toString()
        .padStart(2, '0')}`;
      const current = buckets.get(key) || {
        timestamp: bucketDate.getTime(),
        label,
        responseTimeSum: 0,
        total: 0,
        success: 0,
        failure: 0,
      };

      current.responseTimeSum += log.responseTime;
      current.total += 1;
      if (log.statusCode >= 400) current.failure += 1;
      else current.success += 1;
      buckets.set(key, current);
    }

    return Array.from(buckets.values())
      .sort((a, b) => a.timestamp - b.timestamp)
      .map((item) => ({
        label: item.label,
        avgResponseTime: item.total ? Math.round(item.responseTimeSum / item.total) : 0,
        success: item.success,
        failure: item.failure,
      }))
      .slice(-12);
  }

  private computeErrorRate(apiLogs: Array<{ statusCode: number; createdAt: Date }>) {
    const windowStart = this.addMinutes(new Date(), -10);
    const recent = apiLogs.filter((log) => log.createdAt >= windowStart);
    if (!recent.length) return 0;
    const failures = recent.filter((log) => log.statusCode >= 400).length;
    return Number(((failures / recent.length) * 100).toFixed(2));
  }

  private resolveProviderStatus(
    integrations: Array<{ provider: string; status: string }>,
    providers: string[],
  ) {
    const matched = integrations.filter((integration) => providers.includes(integration.provider));
    if (!matched.length) return 'unknown';
    return matched.some((integration) => integration.status.toLowerCase() === 'connected')
      ? 'up'
      : 'degraded';
  }

  private addDays(date: Date, days: number) {
    const clone = new Date(date);
    clone.setDate(clone.getDate() + days);
    return clone;
  }

  private addMinutes(date: Date, minutes: number) {
    const clone = new Date(date);
    clone.setMinutes(clone.getMinutes() + minutes);
    return clone;
  }

  async onModuleDestroy() {
    if (this.redis && this.redis.status !== 'end') {
      await this.redis.quit().catch(() => undefined);
    }
  }
}
