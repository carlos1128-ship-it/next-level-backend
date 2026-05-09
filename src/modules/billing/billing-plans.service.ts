import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BillingCycle, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { BillingPlanKey } from './constants/billing.constants';

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

const PRICE_ENV: Record<BillingPlanKey, Record<BillingCycle, { product: string; amount: string; fallback: number }>> = {
  COMMON: {
    MONTHLY: {
      product: 'ABACATEPAY_COMMON_MONTHLY_PRODUCT_ID',
      amount: 'PLAN_COMMON_MONTHLY_CENTS',
      fallback: 4990,
    },
    ANNUAL: {
      product: 'ABACATEPAY_COMMON_ANNUAL_PRODUCT_ID',
      amount: 'PLAN_COMMON_ANNUAL_CENTS',
      fallback: 49900,
    },
  },
  PREMIUM: {
    MONTHLY: {
      product: 'ABACATEPAY_PREMIUM_MONTHLY_PRODUCT_ID',
      amount: 'PLAN_PREMIUM_MONTHLY_CENTS',
      fallback: 9700,
    },
    ANNUAL: {
      product: 'ABACATEPAY_PREMIUM_ANNUAL_PRODUCT_ID',
      amount: 'PLAN_PREMIUM_ANNUAL_CENTS',
      fallback: 97000,
    },
  },
  PRO_BUSINESS: {
    MONTHLY: {
      product: 'ABACATEPAY_PRO_BUSINESS_MONTHLY_PRODUCT_ID',
      amount: 'PLAN_PRO_BUSINESS_MONTHLY_CENTS',
      fallback: 19700,
    },
    ANNUAL: {
      product: 'ABACATEPAY_PRO_BUSINESS_ANNUAL_PRODUCT_ID',
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
            abacatepayProductId: this.configService.get<string>(env.product) || null,
            isActive: true,
          },
          update: {
            amountInCents: this.intEnv(env.amount, env.fallback),
            abacatepayProductId: this.configService.get<string>(env.product) || null,
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
            available: Boolean(price.abacatepayProductId),
          };
          return acc;
        }, {}),
      })),
    };
  }

  private intEnv(key: string, fallback: number) {
    const parsed = Number(this.configService.get<string>(key));
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
  }

  private extractMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
}
