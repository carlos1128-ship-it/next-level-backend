import { Injectable, Logger } from '@nestjs/common';
import {
  AIUsageFeature,
  AIUsageProvider,
  AIUsageStatus,
  Plan,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AIUsageLimitExceededException } from './ai-usage-limit.exception';

type UsageTokens = {
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  requestCount?: number | null;
};

type UsageMetadata = Record<string, unknown> | undefined;

type FeatureLimit = {
  monthlyRequestLimit: number | null;
  monthlyTokenLimit: number | null;
  enabled: boolean;
};

const LIMITED_FEATURES = [
  AIUsageFeature.CHAT_IA,
  AIUsageFeature.WHATSAPP_AGENT,
  AIUsageFeature.INTELLIGENT_IMPORT,
];

const DEFAULT_PLAN_LIMITS: Record<string, Partial<Record<AIUsageFeature, FeatureLimit>>> = {
  common: {
    [AIUsageFeature.CHAT_IA]: { monthlyRequestLimit: 500, monthlyTokenLimit: null, enabled: true },
    [AIUsageFeature.WHATSAPP_AGENT]: { monthlyRequestLimit: 1500, monthlyTokenLimit: null, enabled: true },
    [AIUsageFeature.INTELLIGENT_IMPORT]: { monthlyRequestLimit: 100, monthlyTokenLimit: null, enabled: true },
  },
  free: {
    [AIUsageFeature.CHAT_IA]: { monthlyRequestLimit: 100, monthlyTokenLimit: null, enabled: true },
    [AIUsageFeature.WHATSAPP_AGENT]: { monthlyRequestLimit: 300, monthlyTokenLimit: null, enabled: true },
    [AIUsageFeature.INTELLIGENT_IMPORT]: { monthlyRequestLimit: 50, monthlyTokenLimit: null, enabled: true },
  },
  test: {
    [AIUsageFeature.CHAT_IA]: { monthlyRequestLimit: 100, monthlyTokenLimit: null, enabled: true },
    [AIUsageFeature.WHATSAPP_AGENT]: { monthlyRequestLimit: 300, monthlyTokenLimit: null, enabled: true },
    [AIUsageFeature.INTELLIGENT_IMPORT]: { monthlyRequestLimit: 50, monthlyTokenLimit: null, enabled: true },
  },
  basic: {
    [AIUsageFeature.CHAT_IA]: { monthlyRequestLimit: 500, monthlyTokenLimit: null, enabled: true },
    [AIUsageFeature.WHATSAPP_AGENT]: { monthlyRequestLimit: 1500, monthlyTokenLimit: null, enabled: true },
    [AIUsageFeature.INTELLIGENT_IMPORT]: { monthlyRequestLimit: 100, monthlyTokenLimit: null, enabled: true },
  },
  premium: {
    [AIUsageFeature.CHAT_IA]: { monthlyRequestLimit: 3000, monthlyTokenLimit: null, enabled: true },
    [AIUsageFeature.WHATSAPP_AGENT]: { monthlyRequestLimit: 8000, monthlyTokenLimit: null, enabled: true },
    [AIUsageFeature.INTELLIGENT_IMPORT]: { monthlyRequestLimit: 500, monthlyTokenLimit: null, enabled: true },
  },
  business: {
    [AIUsageFeature.CHAT_IA]: { monthlyRequestLimit: 10000, monthlyTokenLimit: null, enabled: true },
    [AIUsageFeature.WHATSAPP_AGENT]: { monthlyRequestLimit: 30000, monthlyTokenLimit: null, enabled: true },
    [AIUsageFeature.INTELLIGENT_IMPORT]: { monthlyRequestLimit: 2000, monthlyTokenLimit: null, enabled: true },
  },
  pro_business: {
    [AIUsageFeature.CHAT_IA]: { monthlyRequestLimit: 10000, monthlyTokenLimit: null, enabled: true },
    [AIUsageFeature.WHATSAPP_AGENT]: { monthlyRequestLimit: 30000, monthlyTokenLimit: null, enabled: true },
    [AIUsageFeature.INTELLIGENT_IMPORT]: { monthlyRequestLimit: 2000, monthlyTokenLimit: null, enabled: true },
  },
};

const FEATURE_LABELS: Record<AIUsageFeature, string> = {
  [AIUsageFeature.CHAT_IA]: 'Chat IA',
  [AIUsageFeature.WHATSAPP_AGENT]: 'Atendente WhatsApp',
  [AIUsageFeature.IMAGE_ANALYSIS]: 'Analise de imagem',
  [AIUsageFeature.AUDIO_TRANSCRIPTION]: 'Transcricao de audio',
  [AIUsageFeature.WEB_SEARCH]: 'Busca web',
  [AIUsageFeature.REPORT_GENERATION]: 'Geracao de relatorio',
  [AIUsageFeature.INTELLIGENT_IMPORT]: 'Importacao Inteligente',
  [AIUsageFeature.OTHER]: 'Outros usos de IA',
};

const FEATURE_UNITS: Record<AIUsageFeature, string> = {
  [AIUsageFeature.CHAT_IA]: 'mensagens',
  [AIUsageFeature.WHATSAPP_AGENT]: 'mensagens',
  [AIUsageFeature.IMAGE_ANALYSIS]: 'analises',
  [AIUsageFeature.AUDIO_TRANSCRIPTION]: 'transcricoes',
  [AIUsageFeature.WEB_SEARCH]: 'buscas',
  [AIUsageFeature.REPORT_GENERATION]: 'relatorios',
  [AIUsageFeature.INTELLIGENT_IMPORT]: 'analises',
  [AIUsageFeature.OTHER]: 'requisicoes',
};

@Injectable()
export class AIUsageService {
  private readonly logger = new Logger(AIUsageService.name);

  constructor(private readonly prisma: PrismaService) {}

  async logUsage(
    companyId: string,
    feature: AIUsageFeature,
    provider: AIUsageProvider,
    model: string | null | undefined,
    tokens: UsageTokens = {},
    status: AIUsageStatus = AIUsageStatus.SUCCESS,
    metadata?: UsageMetadata,
    options?: {
      userId?: string | null;
      estimatedCost?: number | null;
      errorMessage?: string | null;
    },
  ) {
    const normalizedTokens = this.normalizeTokens(tokens);
    const estimatedCost = this.toDecimal(options?.estimatedCost);

    const log = await this.prisma.aIUsageLog.create({
      data: {
        companyId,
        userId: options?.userId || null,
        feature,
        provider,
        model: model || null,
        inputTokens: normalizedTokens.inputTokens,
        outputTokens: normalizedTokens.outputTokens,
        totalTokens: normalizedTokens.totalTokens,
        requestCount: normalizedTokens.requestCount,
        estimatedCost,
        status,
        errorMessage: options?.errorMessage || null,
        metadataJson: this.toJson(metadata),
      },
    });

    if (status === AIUsageStatus.SUCCESS) {
      await this.incrementUsage(
        companyId,
        feature,
        {
          totalTokens: normalizedTokens.totalTokens,
          requestCount: normalizedTokens.requestCount,
        },
        options?.estimatedCost,
      );
    }

    return log;
  }

  async getMonthlyUsage(companyId: string, yearMonth = this.getCurrentYearMonth()) {
    const [planKey, limits, usageRows] = await Promise.all([
      this.resolveCompanyPlanKey(companyId),
      this.getResolvedPlanLimits(companyId),
      this.prisma.companyAIUsageMonthly.findMany({
        where: { companyId, yearMonth },
      }),
    ]);

    const usageByFeature = new Map(usageRows.map((item) => [item.feature, item]));
    const features = Array.from(
      new Set([
        ...LIMITED_FEATURES,
        ...usageRows.map((item) => item.feature),
        ...limits.map((item) => item.feature),
      ]),
    );

    return {
      companyId,
      planKey,
      yearMonth,
      currentMonth: this.formatYearMonth(yearMonth),
      resetMessage: 'O uso de IA zera automaticamente no inicio de cada mes.',
      features: features.map((feature) => {
        const usage = usageByFeature.get(feature);
        const limit = limits.find((item) => item.feature === feature);
        return this.buildUsageFeatureView(feature, usage, limit);
      }),
    };
  }

  async checkLimit(companyId: string, feature: AIUsageFeature) {
    const yearMonth = this.getCurrentYearMonth();
    const [planKey, limit, usage] = await Promise.all([
      this.resolveCompanyPlanKey(companyId),
      this.getFeatureLimit(companyId, feature),
      this.prisma.companyAIUsageMonthly.findUnique({
        where: {
          companyId_yearMonth_feature: {
            companyId,
            yearMonth,
            feature,
          },
        },
      }),
    ]);

    if (!limit || !limit.enabled) {
      return {
        allowed: true,
        companyId,
        planKey,
        feature: this.toFeatureKey(feature),
        requestCount: usage?.requestCount || 0,
        tokenCount: usage?.tokenCount || 0,
        monthlyRequestLimit: limit?.monthlyRequestLimit ?? null,
        monthlyTokenLimit: limit?.monthlyTokenLimit ?? null,
      };
    }

    const requestCount = usage?.requestCount || 0;
    const tokenCount = usage?.tokenCount || 0;
    const requestExceeded =
      limit.monthlyRequestLimit !== null &&
      limit.monthlyRequestLimit !== undefined &&
      requestCount >= limit.monthlyRequestLimit;
    const tokenExceeded =
      limit.monthlyTokenLimit !== null &&
      limit.monthlyTokenLimit !== undefined &&
      tokenCount >= limit.monthlyTokenLimit;

    return {
      allowed: !requestExceeded && !tokenExceeded,
      companyId,
      planKey,
      feature: this.toFeatureKey(feature),
      requestCount,
      tokenCount,
      monthlyRequestLimit: limit.monthlyRequestLimit,
      monthlyTokenLimit: limit.monthlyTokenLimit,
    };
  }

  async enforceLimit(
    companyId: string,
    feature: AIUsageFeature,
    userId?: string | null,
    metadata?: UsageMetadata,
  ) {
    const result = await this.checkLimit(companyId, feature);
    if (result.allowed) return result;

    await this.logUsage(
      companyId,
      feature,
      AIUsageProvider.INTERNAL,
      null,
      { requestCount: 1 },
      AIUsageStatus.BLOCKED,
      {
        ...metadata,
        reason: 'monthly_limit_exceeded',
        planKey: result.planKey,
      },
      {
        userId,
        errorMessage: 'Limite de IA atingido para este mês.',
      },
    ).catch((error) => {
      this.logger.warn(`Falha ao registrar bloqueio de IA: ${this.extractErrorMessage(error)}`);
    });

    throw new AIUsageLimitExceededException();
  }

  async incrementUsage(
    companyId: string,
    feature: AIUsageFeature,
    tokens: UsageTokens = {},
    estimatedCost?: number | null,
  ) {
    const normalizedTokens = this.normalizeTokens(tokens);
    const tokenCount = normalizedTokens.totalTokens || 0;
    const cost = this.toDecimal(estimatedCost) || new Prisma.Decimal(0);
    const yearMonth = this.getCurrentYearMonth();

    const updated = await this.prisma.companyAIUsageMonthly.upsert({
      where: {
        companyId_yearMonth_feature: {
          companyId,
          yearMonth,
          feature,
        },
      },
      create: {
        companyId,
        yearMonth,
        feature,
        requestCount: normalizedTokens.requestCount,
        tokenCount,
        estimatedCost: cost,
      },
      update: {
        requestCount: { increment: normalizedTokens.requestCount },
        tokenCount: { increment: tokenCount },
        estimatedCost: { increment: cost },
      },
    });

    await this.incrementLegacyUsageQuota(companyId, tokenCount);
    return updated;
  }

  async getPlanLimits(companyId: string) {
    const [planKey, limits] = await Promise.all([
      this.resolveCompanyPlanKey(companyId),
      this.getResolvedPlanLimits(companyId),
    ]);

    return {
      companyId,
      planKey,
      limits: limits.map((item) => ({
        feature: this.toFeatureKey(item.feature),
        label: FEATURE_LABELS[item.feature],
        unit: FEATURE_UNITS[item.feature],
        monthlyRequestLimit: item.monthlyRequestLimit,
        monthlyTokenLimit: item.monthlyTokenLimit,
        enabled: item.enabled,
      })),
    };
  }

  async getLogs(companyId: string, page = 1, limit = 25) {
    const safePage = Math.max(1, Number(page) || 1);
    const safeLimit = Math.min(100, Math.max(1, Number(limit) || 25));
    const where = { companyId };
    const [data, total] = await Promise.all([
      this.prisma.aIUsageLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (safePage - 1) * safeLimit,
        take: safeLimit,
      }),
      this.prisma.aIUsageLog.count({ where }),
    ]);

    return {
      data: data.map((item) => ({
        ...item,
        feature: this.toFeatureKey(item.feature),
        provider: this.toProviderKey(item.provider),
        status: this.toStatusKey(item.status),
        estimatedCost: item.estimatedCost ? Number(item.estimatedCost) : null,
      })),
      pagination: {
        page: safePage,
        limit: safeLimit,
        total,
        totalPages: Math.ceil(total / safeLimit),
      },
    };
  }

  getCurrentYearMonth(date = new Date()) {
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
  }

  private async getResolvedPlanLimits(companyId: string) {
    const planKey = await this.resolveCompanyPlanKey(companyId);
    const defaults = DEFAULT_PLAN_LIMITS[planKey] || DEFAULT_PLAN_LIMITS.free;
    const overridePlanKeys = this.getPlanOverrideKeys(planKey);
    const overrides = await this.prisma.aIUsageLimit.findMany({
      where: { planKey: { in: overridePlanKeys } },
    });
    const overrideByFeature = new Map(overrides.map((item) => [item.feature, item]));

    return LIMITED_FEATURES.map((feature) => {
      const fallback = defaults[feature] || {
        monthlyRequestLimit: null,
        monthlyTokenLimit: null,
        enabled: true,
      };
      const override = overrideByFeature.get(feature);
      return {
        feature,
        monthlyRequestLimit: override?.monthlyRequestLimit ?? fallback.monthlyRequestLimit,
        monthlyTokenLimit: override?.monthlyTokenLimit ?? fallback.monthlyTokenLimit,
        enabled: override?.enabled ?? fallback.enabled,
      };
    });
  }

  private async getFeatureLimit(companyId: string, feature: AIUsageFeature) {
    const planKey = await this.resolveCompanyPlanKey(companyId);
    const override = await this.prisma.aIUsageLimit.findUnique({
      where: {
        planKey_feature: {
          planKey,
          feature,
        },
      },
    });

    const legacyOverride =
      override ||
      (await this.findLegacyPlanOverride(planKey, feature));

    if (legacyOverride) {
      return {
        monthlyRequestLimit: legacyOverride.monthlyRequestLimit,
        monthlyTokenLimit: legacyOverride.monthlyTokenLimit,
        enabled: legacyOverride.enabled,
      };
    }

    return DEFAULT_PLAN_LIMITS[planKey]?.[feature] || null;
  }

  private async resolveCompanyPlanKey(companyId: string) {
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: {
        userId: true,
        users: {
          select: { plan: true },
          take: 1,
        },
      },
    });

    const ownerPlan = company?.userId
      ? await this.prisma.user.findUnique({
          where: { id: company.userId },
          select: { plan: true },
        })
      : null;

    return this.mapPlanToKey(ownerPlan?.plan || company?.users[0]?.plan || null);
  }

  private mapPlanToKey(plan: Plan | null | undefined) {
    if (plan === Plan.PRO) return 'premium';
    if (plan === Plan.ENTERPRISE) return 'pro_business';
    if (plan === Plan.COMUM) return 'common';
    return 'free';
  }

  private getPlanOverrideKeys(planKey: string) {
    if (planKey === 'common') return ['common', 'basic'];
    if (planKey === 'pro_business') return ['pro_business', 'business'];
    return [planKey];
  }

  private async findLegacyPlanOverride(planKey: string, feature: AIUsageFeature) {
    const legacyKeys = this.getPlanOverrideKeys(planKey).filter((key) => key !== planKey);
    if (!legacyKeys.length) return null;
    if (typeof this.prisma.aIUsageLimit.findFirst !== 'function') return null;
    return this.prisma.aIUsageLimit.findFirst({
      where: {
        planKey: { in: legacyKeys },
        feature,
      },
    });
  }

  private buildUsageFeatureView(
    feature: AIUsageFeature,
    usage:
      | {
          requestCount: number;
          tokenCount: number;
          estimatedCost: Prisma.Decimal;
        }
      | undefined,
    limit:
      | {
          monthlyRequestLimit: number | null;
          monthlyTokenLimit: number | null;
          enabled: boolean;
        }
      | undefined,
  ) {
    const used = usage?.requestCount || 0;
    const requestLimit = limit?.monthlyRequestLimit ?? null;
    const percent = requestLimit && requestLimit > 0 ? Math.min(100, Math.round((used / requestLimit) * 100)) : 0;
    const status = requestLimit && used >= requestLimit ? 'exceeded' : requestLimit && used >= requestLimit * 0.8 ? 'near_limit' : 'ok';

    return {
      feature: this.toFeatureKey(feature),
      label: FEATURE_LABELS[feature],
      unit: FEATURE_UNITS[feature],
      requestCount: used,
      tokenCount: usage?.tokenCount || 0,
      monthlyRequestLimit: requestLimit,
      monthlyTokenLimit: limit?.monthlyTokenLimit ?? null,
      enabled: limit?.enabled ?? true,
      progressPercent: percent,
      status,
    };
  }

  private normalizeTokens(tokens: UsageTokens) {
    const inputTokens = this.toPositiveInteger(tokens.inputTokens);
    const outputTokens = this.toPositiveInteger(tokens.outputTokens);
    const totalTokens =
      this.toPositiveInteger(tokens.totalTokens) ??
      (inputTokens !== null || outputTokens !== null
        ? (inputTokens || 0) + (outputTokens || 0)
        : null);

    return {
      inputTokens,
      outputTokens,
      totalTokens,
      requestCount: Math.max(1, this.toPositiveInteger(tokens.requestCount) || 1),
    };
  }

  private async incrementLegacyUsageQuota(
    companyId: string,
    tokenCount: number,
  ) {
    if (tokenCount <= 0) return;

    try {
      await this.prisma.usageQuota.upsert({
        where: { companyId },
        create: {
          companyId,
          currentTier: Plan.COMUM,
          billingCycleEnd: this.addDays(new Date(), 30),
          llmTokensUsed: tokenCount,
          whatsappMessagesSent: 0,
        },
        update: {
          llmTokensUsed: { increment: tokenCount },
        },
      });
    } catch (error) {
      this.logger.warn(`Falha ao manter UsageQuota legado: ${this.extractErrorMessage(error)}`);
    }
  }

  private toPositiveInteger(value: unknown) {
    const numberValue = Number(value);
    if (!Number.isFinite(numberValue) || numberValue < 0) return null;
    return Math.round(numberValue);
  }

  private toDecimal(value: number | null | undefined) {
    if (value === null || value === undefined) return null;
    const numberValue = Number(value);
    if (!Number.isFinite(numberValue) || numberValue < 0) return null;
    return new Prisma.Decimal(numberValue);
  }

  private toJson(metadata: UsageMetadata) {
    if (!metadata) return undefined;
    return metadata as Prisma.InputJsonValue;
  }

  private toFeatureKey(feature: AIUsageFeature) {
    return feature.toLowerCase();
  }

  private toProviderKey(provider: AIUsageProvider) {
    return provider.toLowerCase();
  }

  private toStatusKey(status: AIUsageStatus) {
    return status.toLowerCase();
  }

  private formatYearMonth(yearMonth: string) {
    const [year, month] = yearMonth.split('-').map(Number);
    if (!year || !month) return yearMonth;
    return new Intl.DateTimeFormat('pt-BR', {
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(new Date(Date.UTC(year, month - 1, 1)));
  }

  private addDays(date: Date, days: number) {
    const clone = new Date(date);
    clone.setUTCDate(clone.getUTCDate() + days);
    return clone;
  }

  private extractErrorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
}
