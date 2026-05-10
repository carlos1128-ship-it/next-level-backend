import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BillingCycle, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { BillingPlanKey } from './constants/billing.constants';
import { PaymentProviderResolver } from './providers/payment-provider.resolver';

const PLAN_DEFINITIONS: Array<{
  key: BillingPlanKey;
  name: string;
  description: string;
  level: number;
  features: string[];
}> = [
  {
    key: 'COMMON',
    name: 'Comum',
    description:
      'Plano inicial para negocios que querem organizar dados e acompanhar indicadores basicos.',
    level: 1,
    features: [
      'Dashboard essencial',
      'Cadastro manual de vendas, produtos, clientes e custos',
      'Visao basica de vendas e financas',
      'Relatorios simples',
      'Insights limitados de IA',
      'Suporte padrao',
    ],
  },
  {
    key: 'PREMIUM',
    name: 'Premium',
    description:
      'Plano para empresas que querem usar IA de verdade na gestao e enxergar crescimento.',
    level: 2,
    features: [
      'Tudo do Comum',
      'Chat IA com contexto do negocio',
      'Analises financeiras avancadas',
      'Alertas inteligentes',
      'Relatorios completos',
      'Integracoes principais',
      'Atendente IA, se disponivel',
    ],
  },
  {
    key: 'PRO_BUSINESS',
    name: 'Pro Business',
    description:
      'Plano completo para automacao, inteligencia de mercado e recursos avancados.',
    level: 3,
    features: [
      'Tudo do Premium',
      'IA estrategica avancada',
      'Automacoes inteligentes',
      'Market intelligence',
      'Maior limite de dados',
      'Previsoes avancadas',
      'Prioridade em novas funcionalidades',
    ],
  },
];

const PRICE_ENV: Record<BillingPlanKey, Record<BillingCycle, { abacateProduct: string; amount: string; fallback: number }>> = {
  COMMON: {
    MONTHLY: {
      abacateProduct: 'ABACATEPAY_COMMON_MONTHLY_PRODUCT_ID',
      amount: 'PLAN_COMMON_MONTHLY_CENTS',
      fallback: 4990,
    },
    ANNUAL: {
      abacateProduct: 'ABACATEPAY_COMMON_ANNUAL_PRODUCT_ID',
      amount: 'PLAN_COMMON_ANNUAL_CENTS',
      fallback: 49900,
    },
  },
  PREMIUM: {
    MONTHLY: {
      abacateProduct: 'ABACATEPAY_PREMIUM_MONTHLY_PRODUCT_ID',
      amount: 'PLAN_PREMIUM_MONTHLY_CENTS',
      fallback: 9700,
    },
    ANNUAL: {
      abacateProduct: 'ABACATEPAY_PREMIUM_ANNUAL_PRODUCT_ID',
      amount: 'PLAN_PREMIUM_ANNUAL_CENTS',
      fallback: 97000,
    },
  },
  PRO_BUSINESS: {
    MONTHLY: {
      abacateProduct: 'ABACATEPAY_PRO_BUSINESS_MONTHLY_PRODUCT_ID',
      amount: 'PLAN_PRO_BUSINESS_MONTHLY_CENTS',
      fallback: 19700,
    },
    ANNUAL: {
      abacateProduct: 'ABACATEPAY_PRO_BUSINESS_ANNUAL_PRODUCT_ID',
      amount: 'PLAN_PRO_BUSINESS_ANNUAL_CENTS',
      fallback: 197000,
    },
  },
};

@Injectable()
export class BillingPlansService implements OnModuleInit {
  private readonly logger = new Logger(BillingPlansService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly paymentProviderResolver: PaymentProviderResolver,
  ) {}

  async onModuleInit() {
    await this.bootstrapPlans().catch((error) => {
      this.logger.warn(`Billing bootstrap adiado: ${this.extractMessage(error)}`);
    });
  }

  async bootstrapPlans() {
    for (const definition of PLAN_DEFINITIONS) {
      const plan = await this.prisma.billingPlan.upsert({
        where: { key: definition.key },
        create: {
          key: definition.key,
          name: definition.name,
          description: definition.description,
          level: definition.level,
          features: definition.features as Prisma.InputJsonValue,
        },
        update: {
          name: definition.name,
          description: definition.description,
          level: definition.level,
          features: definition.features as Prisma.InputJsonValue,
          isActive: true,
        },
      });

      for (const billingCycle of [BillingCycle.MONTHLY, BillingCycle.ANNUAL]) {
        const env = PRICE_ENV[definition.key][billingCycle];
        const providerConfig = this.providerConfig(definition.key, billingCycle);
        await this.prisma.billingPlanPrice.upsert({
          where: {
            planId_billingCycle: {
              planId: plan.id,
              billingCycle,
            },
          },
          create: {
            planId: plan.id,
            billingCycle,
            amountInCents: this.intEnv(env.amount, env.fallback),
            provider: providerConfig.provider,
            providerProductId: providerConfig.productId,
            providerOfferId: providerConfig.offerId,
            providerCheckoutUrl: providerConfig.checkoutUrl,
            providerMetadata: providerConfig.metadata ?? Prisma.JsonNull,
            abacatepayProductId: this.configService.get<string>(env.abacateProduct) || null,
            isActive: true,
          },
          update: {
            amountInCents: this.intEnv(env.amount, env.fallback),
            provider: providerConfig.provider,
            providerProductId: providerConfig.productId,
            providerOfferId: providerConfig.offerId,
            providerCheckoutUrl: providerConfig.checkoutUrl,
            providerMetadata: providerConfig.metadata ?? Prisma.JsonNull,
            abacatepayProductId: this.configService.get<string>(env.abacateProduct) || null,
            isActive: true,
          },
        });
      }
    }
  }

  async listPlans() {
    await this.bootstrapPlans();
    const plans = await this.prisma.billingPlan.findMany({
      where: { isActive: true },
      include: {
        prices: {
          where: { isActive: true },
          orderBy: { billingCycle: 'asc' },
        },
      },
      orderBy: { level: 'asc' },
    });

    return {
      plans: plans.map((plan) => ({
        key: plan.key,
        name: plan.name,
        description: plan.description,
        level: plan.level,
        features: Array.isArray(plan.features) ? plan.features : [],
        prices: plan.prices.reduce<Record<string, unknown>>((acc, price) => {
          acc[price.billingCycle] = {
            amountInCents: price.amountInCents,
            currency: price.currency,
            available: this.isPriceAvailable(price),
            provider: price.provider,
          };
          return acc;
        }, {}),
      })),
    };
  }

  private providerConfig(planKey: BillingPlanKey, billingCycle: BillingCycle) {
    const provider = this.paymentProviderResolver.activeProviderKey;
    if (provider === 'CAKTO') {
      const prefix = `CAKTO_${planKey}_${billingCycle}`;
      const productId = this.configService.get<string>(`${prefix}_PRODUCT_ID`) || null;
      const offerId = this.configService.get<string>(`${prefix}_OFFER_ID`) || null;
      const checkoutUrl = this.configService.get<string>(`${prefix}_CHECKOUT_URL`) || null;
      return {
        provider,
        productId,
        offerId,
        checkoutUrl,
        metadata: {
          type: 'subscription',
          integrationStrategy: 'fixed_checkout_link',
        } as Prisma.InputJsonValue,
      };
    }

    if (provider === 'ABACATEPAY') {
      const env = PRICE_ENV[planKey][billingCycle];
      return {
        provider,
        productId: this.configService.get<string>(env.abacateProduct) || null,
        offerId: null,
        checkoutUrl: null,
        metadata: null,
      };
    }

    return {
      provider,
      productId: null,
      offerId: null,
      checkoutUrl: null,
      metadata: null,
    };
  }

  private isPriceAvailable(price: {
    provider: string;
    providerCheckoutUrl?: string | null;
    abacatepayProductId?: string | null;
  }) {
    const activeProvider = this.paymentProviderResolver.activeProviderKey;
    if (activeProvider === 'CAKTO') {
      return price.provider === 'CAKTO' && Boolean(price.providerCheckoutUrl);
    }
    if (activeProvider === 'ABACATEPAY') {
      return price.provider === 'ABACATEPAY' && Boolean(price.abacatepayProductId);
    }
    return false;
  }

  private intEnv(key: string, fallback: number) {
    const parsed = Number(this.configService.get<string>(key));
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
  }

  private extractMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
}
