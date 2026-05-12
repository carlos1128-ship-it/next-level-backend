import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { AIUsageFeature, IntegrationProvider, Plan, SubscriptionStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  BillingPlanKey,
  PLAN_LEVELS,
  normalizeBillingPlanKey,
} from './constants/billing.constants';

export type PlanFeatureKey =
  | 'DASHBOARD_BASIC'
  | 'DASHBOARD_ADVANCED'
  | 'REPORTS_SIMPLE'
  | 'REPORTS_AUTOMATIC'
  | 'AI_CHAT'
  | 'SMART_IMPORTS'
  | 'WHATSAPP_INTEGRATION'
  | 'INSTAGRAM_INTEGRATION'
  | 'MERCADO_LIVRE_INTEGRATION'
  | 'UTMIFY_INTEGRATION'
  | 'MARKETPLACE_INTEGRATIONS'
  | 'WHATSAPP_AI_ATTENDANT'
  | 'INSTAGRAM_AI_ATTENDANT'
  | 'MARKET_INTELLIGENCE'
  | 'ADVANCED_FORECAST'
  | 'ADVANCED_AUTOMATIONS'
  | 'PRIORITY_SUPPORT'
  | 'DEDICATED_SUPPORT';

export type PlanQuotaKey =
  | 'AI_CHAT_MESSAGES'
  | 'WHATSAPP_ATTENDANT_MESSAGES'
  | 'INSTAGRAM_ATTENDANT_MESSAGES'
  | 'SMART_IMPORTS';

export type PlanEntitlementDefinition = {
  key: BillingPlanKey;
  name: string;
  description: string;
  level: number;
  monthlyPriceInCents: number;
  annualPriceInCents: number;
  features: string[];
  featureKeys: PlanFeatureKey[];
  quotas: Record<PlanQuotaKey, number | null>;
};

export const PLAN_CATALOG: Record<BillingPlanKey, PlanEntitlementDefinition> = {
  COMMON: {
    key: 'COMMON',
    name: 'Essencial',
    description:
      'Plano inicial para organizar dados, acompanhar indicadores e usar IA basica sem integracoes automaticas.',
    level: 1,
    monthlyPriceInCents: 5700,
    annualPriceInCents: 57000,
    features: [
      'Dashboard essencial',
      'Cadastro manual de dados',
      'Visao basica de vendas e financas',
      'Relatorios simples',
      'Chat IA: 400 mensagens/mes',
      'Analises de dados com IA: 30 por mes',
      'Atendente IA: nao incluso',
      '1 importacao inteligente por dia',
      'Sem integracoes automaticas',
      'Suporte via e-mail',
    ],
    featureKeys: [
      'DASHBOARD_BASIC',
      'REPORTS_SIMPLE',
      'AI_CHAT',
      'SMART_IMPORTS',
    ],
    quotas: {
      AI_CHAT_MESSAGES: 400,
      WHATSAPP_ATTENDANT_MESSAGES: 0,
      INSTAGRAM_ATTENDANT_MESSAGES: 0,
      SMART_IMPORTS: 30,
    },
  },
  PREMIUM: {
    key: 'PREMIUM',
    name: 'Premium',
    description:
      'Plano para empresas que querem usar IA, atendimento automatico e integracoes principais para crescer com mais clareza.',
    level: 2,
    monthlyPriceInCents: 9700,
    annualPriceInCents: 97000,
    features: [
      'Tudo do Essencial',
      'Mais volume para analises, relatorios e recomendacoes da operacao',
      'Chat IA: 1.000 mensagens/mes',
      'Analises de dados com IA: 240 por mes',
      'WhatsApp: 3.000 mensagens/mes',
      'Instagram: 3.000 mensagens/mes',
      'Ate 10 empresas vinculadas',
      'WhatsApp + Instagram integrados',
      'Atendente IA para WhatsApp e Instagram',
      'Alertas inteligentes de margem',
      'Relatorios automaticos semanais',
      'Recomendacoes taticas da IA',
      'Suporte prioritario',
      'Sem Mercado Livre e Utmify',
    ],
    featureKeys: [
      'DASHBOARD_BASIC',
      'DASHBOARD_ADVANCED',
      'REPORTS_SIMPLE',
      'REPORTS_AUTOMATIC',
      'AI_CHAT',
      'SMART_IMPORTS',
      'WHATSAPP_INTEGRATION',
      'INSTAGRAM_INTEGRATION',
      'WHATSAPP_AI_ATTENDANT',
      'INSTAGRAM_AI_ATTENDANT',
      'PRIORITY_SUPPORT',
    ],
    quotas: {
      AI_CHAT_MESSAGES: 1000,
      WHATSAPP_ATTENDANT_MESSAGES: 3000,
      INSTAGRAM_ATTENDANT_MESSAGES: 3000,
      SMART_IMPORTS: 240,
    },
  },
  PRO_BUSINESS: {
    key: 'PRO_BUSINESS',
    name: 'Business',
    description:
      'Plano completo para operacoes que precisam de automacao, previsibilidade, market intelligence e escala.',
    level: 3,
    monthlyPriceInCents: 19700,
    annualPriceInCents: 197000,
    features: [
      'Tudo do Premium',
      'Maior volume de IA para dados, canais e atendimento em escala',
      'Chat IA: 5.000 mensagens/mes',
      'Analises de dados com IA: ilimitadas',
      'WhatsApp: 10.000 mensagens/mes',
      'Instagram: 10.000 mensagens/mes',
      'Empresas ilimitadas',
      'Mercado Livre + Utmify + marketplaces',
      'IA estrategica avancada',
      'Automacoes inteligentes',
      'Market intelligence',
      'Previsoes e alertas avancados',
      'Importacoes inteligentes ilimitadas',
      'Prioridade em novas funcionalidades',
    ],
    featureKeys: [
      'DASHBOARD_BASIC',
      'DASHBOARD_ADVANCED',
      'REPORTS_SIMPLE',
      'REPORTS_AUTOMATIC',
      'AI_CHAT',
      'SMART_IMPORTS',
      'WHATSAPP_INTEGRATION',
      'INSTAGRAM_INTEGRATION',
      'MERCADO_LIVRE_INTEGRATION',
      'UTMIFY_INTEGRATION',
      'MARKETPLACE_INTEGRATIONS',
      'WHATSAPP_AI_ATTENDANT',
      'INSTAGRAM_AI_ATTENDANT',
      'MARKET_INTELLIGENCE',
      'ADVANCED_FORECAST',
      'ADVANCED_AUTOMATIONS',
      'PRIORITY_SUPPORT',
      'DEDICATED_SUPPORT',
    ],
    quotas: {
      AI_CHAT_MESSAGES: 5000,
      WHATSAPP_ATTENDANT_MESSAGES: 10000,
      INSTAGRAM_ATTENDANT_MESSAGES: 10000,
      SMART_IMPORTS: null,
    },
  },
};

export const AI_FEATURE_TO_QUOTA: Partial<Record<AIUsageFeature, PlanQuotaKey>> = {
  [AIUsageFeature.CHAT_IA]: 'AI_CHAT_MESSAGES',
  [AIUsageFeature.WHATSAPP_AGENT]: 'WHATSAPP_ATTENDANT_MESSAGES',
  [AIUsageFeature.INSTAGRAM_AGENT]: 'INSTAGRAM_ATTENDANT_MESSAGES',
  [AIUsageFeature.INTELLIGENT_IMPORT]: 'SMART_IMPORTS',
};

export const AI_FEATURE_TO_ENTITLEMENT: Partial<Record<AIUsageFeature, PlanFeatureKey>> = {
  [AIUsageFeature.CHAT_IA]: 'AI_CHAT',
  [AIUsageFeature.WHATSAPP_AGENT]: 'WHATSAPP_AI_ATTENDANT',
  [AIUsageFeature.INSTAGRAM_AGENT]: 'INSTAGRAM_AI_ATTENDANT',
  [AIUsageFeature.INTELLIGENT_IMPORT]: 'SMART_IMPORTS',
};

const FEATURE_LABELS: Record<PlanFeatureKey, string> = {
  DASHBOARD_BASIC: 'Dashboard essencial',
  DASHBOARD_ADVANCED: 'Dashboard avancado',
  REPORTS_SIMPLE: 'Relatorios simples',
  REPORTS_AUTOMATIC: 'Relatorios automaticos',
  AI_CHAT: 'Chat IA',
  SMART_IMPORTS: 'Importacoes inteligentes',
  WHATSAPP_INTEGRATION: 'Integracao WhatsApp',
  INSTAGRAM_INTEGRATION: 'Integracao Instagram',
  MERCADO_LIVRE_INTEGRATION: 'Integracao Mercado Livre',
  UTMIFY_INTEGRATION: 'Integracao Utmify',
  MARKETPLACE_INTEGRATIONS: 'Marketplaces',
  WHATSAPP_AI_ATTENDANT: 'Atendente IA WhatsApp',
  INSTAGRAM_AI_ATTENDANT: 'Atendente IA Instagram',
  MARKET_INTELLIGENCE: 'Market intelligence',
  ADVANCED_FORECAST: 'Forecast avancado',
  ADVANCED_AUTOMATIONS: 'Automacoes avancadas',
  PRIORITY_SUPPORT: 'Suporte prioritario',
  DEDICATED_SUPPORT: 'Suporte dedicado',
};

const INTEGRATION_FEATURES: Record<string, PlanFeatureKey> = {
  WHATSAPP: 'WHATSAPP_INTEGRATION',
  INSTAGRAM: 'INSTAGRAM_INTEGRATION',
  MERCADOLIVRE: 'MERCADO_LIVRE_INTEGRATION',
  MERCADO_LIVRE: 'MERCADO_LIVRE_INTEGRATION',
  UTMIFY: 'UTMIFY_INTEGRATION',
  SHOPEE: 'MARKETPLACE_INTEGRATIONS',
};

@Injectable()
export class PlanEntitlementsService {
  constructor(private readonly prisma: PrismaService) {}

  getEntitlements(planKey: unknown) {
    return PLAN_CATALOG[this.normalizePlanOrDefault(planKey)];
  }

  canAccessFeature(planKey: unknown, featureKey: PlanFeatureKey) {
    return this.getEntitlements(planKey).featureKeys.includes(featureKey);
  }

  getQuota(planKey: unknown, quotaKey: PlanQuotaKey) {
    return this.getEntitlements(planKey).quotas[quotaKey] ?? null;
  }

  getRequiredPlanForFeature(featureKey: PlanFeatureKey): BillingPlanKey {
    const match = Object.values(PLAN_CATALOG)
      .sort((a, b) => a.level - b.level)
      .find((plan) => plan.featureKeys.includes(featureKey));
    return match?.key || 'PRO_BUSINESS';
  }

  getRecommendedUpgradePlan(planKey: unknown, quotaKey: PlanQuotaKey): BillingPlanKey {
    const current = this.normalizePlanOrDefault(planKey);
    const currentQuota = this.getQuota(current, quotaKey);
    const currentLevel = PLAN_LEVELS[current];
    const match = Object.values(PLAN_CATALOG)
      .sort((a, b) => a.level - b.level)
      .find((plan) => {
        if (plan.level <= currentLevel) return false;
        const quota = plan.quotas[quotaKey];
        return quota === null || (typeof quota === 'number' && typeof currentQuota === 'number' && quota > currentQuota);
      });
    return match?.key || 'PRO_BUSINESS';
  }

  async assertFeatureAccessForCompany(companyId: string, featureKey: PlanFeatureKey) {
    const planKey = await this.resolveCompanyPlanKey(companyId);
    if (this.canAccessFeature(planKey, featureKey)) {
      return { allowed: true, planKey, featureKey };
    }

    const requiredPlan = this.getRequiredPlanForFeature(featureKey);
    throw new HttpException(
      {
        statusCode: HttpStatus.FORBIDDEN,
        code: 'FEATURE_NOT_INCLUDED',
        feature: featureKey,
        currentPlan: planKey,
        requiredPlan,
        message: `${FEATURE_LABELS[featureKey]} esta disponivel a partir do plano ${PLAN_CATALOG[requiredPlan].name}.`,
      },
      HttpStatus.FORBIDDEN,
    );
  }

  async assertIntegrationAccessForCompany(
    companyId: string,
    provider: IntegrationProvider | string,
  ) {
    const normalized = String(provider || '').trim().toUpperCase();
    const featureKey = INTEGRATION_FEATURES[normalized] || 'MARKETPLACE_INTEGRATIONS';
    const planKey = await this.resolveCompanyPlanKey(companyId);
    if (this.canAccessFeature(planKey, featureKey)) {
      return { allowed: true, planKey, integration: normalized };
    }

    const requiredPlan = this.getRequiredPlanForFeature(featureKey);
    throw new HttpException(
      {
        statusCode: HttpStatus.FORBIDDEN,
        code: 'INTEGRATION_NOT_INCLUDED',
        integration: normalized,
        currentPlan: planKey,
        requiredPlan,
        message: `A integracao com ${this.integrationLabel(normalized)} esta disponivel no plano ${PLAN_CATALOG[requiredPlan].name}.`,
      },
      HttpStatus.FORBIDDEN,
    );
  }

  async assertQuotaAvailableForCompany(input: {
    companyId: string;
    quotaKey: PlanQuotaKey;
    used: number;
  }) {
    const planKey = await this.resolveCompanyPlanKey(input.companyId);
    const quota = this.getQuota(planKey, input.quotaKey);
    if (quota === null || input.used < quota) {
      return { allowed: true, planKey, quota };
    }

    const requiredPlan = this.getRecommendedUpgradePlan(planKey, input.quotaKey);
    throw new HttpException(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        code: 'PLAN_LIMIT_REACHED',
        feature: input.quotaKey,
        currentPlan: planKey,
        requiredPlan,
        message: 'Voce atingiu o limite do seu plano. Faca upgrade para continuar usando.',
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  async incrementUsage() {
    return null;
  }

  async resolveCompanyPlanKey(companyId: string): Promise<BillingPlanKey> {
    const activeSubscription = await this.prisma.subscription.findFirst({
      where: {
        companyId,
        status: { in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.PAID] },
      },
      orderBy: { createdAt: 'desc' },
      select: { planKey: true },
    });
    const subscriptionPlan = normalizeBillingPlanKey(activeSubscription?.planKey);
    if (subscriptionPlan) return subscriptionPlan;

    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: {
        userId: true,
        usageQuota: { select: { currentTier: true } },
        users: { select: { plan: true }, take: 1 },
      },
    });

    if (company?.usageQuota?.currentTier) {
      return this.mapLegacyPlan(company.usageQuota.currentTier);
    }

    if (company?.userId) {
      const owner = await this.prisma.user.findUnique({
        where: { id: company.userId },
        select: { plan: true },
      });
      if (owner?.plan) return this.mapLegacyPlan(owner.plan);
    }

    return this.mapLegacyPlan(company?.users[0]?.plan || Plan.COMUM);
  }

  private normalizePlanOrDefault(planKey: unknown): BillingPlanKey {
    return normalizeBillingPlanKey(planKey) || 'COMMON';
  }

  private mapLegacyPlan(plan: Plan): BillingPlanKey {
    if (plan === Plan.PRO) return 'PREMIUM';
    if (plan === Plan.ENTERPRISE) return 'PRO_BUSINESS';
    return 'COMMON';
  }

  private integrationLabel(provider: string) {
    const labels: Record<string, string> = {
      WHATSAPP: 'WhatsApp',
      INSTAGRAM: 'Instagram',
      MERCADOLIVRE: 'Mercado Livre',
      MERCADO_LIVRE: 'Mercado Livre',
      UTMIFY: 'Utmify',
      SHOPEE: 'Shopee',
    };
    return labels[provider] || provider;
  }
}
