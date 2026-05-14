import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BillingCycle, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { BillingPlanKey } from './constants/billing.constants';
import { PLAN_CATALOG } from './plan-entitlements.service';

const PLAN_DEFINITIONS = Object.values(PLAN_CATALOG);

const PRICE_ENV: Record<BillingPlanKey, Record<BillingCycle, { price: string; amount: string; fallback: number }>> = {
  COMMON: {
    MONTHLY: {
      price: 'STRIPE_PRICE_ESSENTIAL_MONTHLY',
      amount: 'PLAN_COMMON_MONTHLY_CENTS',
      fallback: 5700,
    },
    ANNUAL: {
      price: 'STRIPE_PRICE_ESSENTIAL_YEARLY',
      amount: 'PLAN_COMMON_ANNUAL_CENTS',
      fallback: 57000,
    },
  },
  PREMIUM: {
    MONTHLY: {
      price: 'STRIPE_PRICE_PREMIUM_MONTHLY',
      amount: 'PLAN_PREMIUM_MONTHLY_CENTS',
      fallback: 9700,
    },
    ANNUAL: {
      price: 'STRIPE_PRICE_PREMIUM_YEARLY',
      amount: 'PLAN_PREMIUM_ANNUAL_CENTS',
      fallback: 97000,
    },
  },
  PRO_BUSINESS: {
    MONTHLY: {
      price: 'STRIPE_PRICE_PRO_BUSINESS_MONTHLY',
      amount: 'PLAN_PRO_BUSINESS_MONTHLY_CENTS',
      fallback: 19700,
    },
    ANNUAL: {
      price: 'STRIPE_PRICE_PRO_BUSINESS_YEARLY',
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
        const stripePriceId = this.configService.get<string>(env.price)?.trim() || null;
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
            provider: 'STRIPE',
            providerProductId: stripePriceId,
            stripePriceId,
            providerMetadata: {
              app: 'next_level_ai',
              priceEnv: env.price,
            } as Prisma.InputJsonValue,
            isActive: true,
          },
          update: {
            amountInCents: this.intEnv(env.amount, env.fallback),
            provider: 'STRIPE',
            providerProductId: stripePriceId,
            stripePriceId,
            providerMetadata: {
              app: 'next_level_ai',
              priceEnv: env.price,
            } as Prisma.InputJsonValue,
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
            available: Boolean(price.stripePriceId),
            provider: 'STRIPE',
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
