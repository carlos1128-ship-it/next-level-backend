import { BillingCycle, PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();
const BCRYPT_ROUNDS = Number(process.env.BCRYPT_ROUNDS || 12);

const billingPlans = [
  {
    key: 'COMMON',
    name: 'Comum',
    description: 'Plano inicial para organizar dados e acompanhar indicadores basicos.',
    level: 1,
    features: [
      'Dashboard essencial',
      'Cadastro manual de dados',
      'Visao basica de vendas e financas',
      'Relatorios simples',
      'Insights limitados de IA',
      'Suporte padrao',
    ],
  },
  {
    key: 'PREMIUM',
    name: 'Premium',
    description: 'Plano para usar IA de verdade na gestao e enxergar oportunidades.',
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
    description: 'Plano completo para automacao, inteligencia de mercado e previsoes.',
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

const priceEnv = {
  COMMON: {
    MONTHLY: ['ABACATEPAY_COMMON_MONTHLY_PRODUCT_ID', 'PLAN_COMMON_MONTHLY_CENTS', 4990],
    ANNUAL: ['ABACATEPAY_COMMON_ANNUAL_PRODUCT_ID', 'PLAN_COMMON_ANNUAL_CENTS', 49900],
  },
  PREMIUM: {
    MONTHLY: ['ABACATEPAY_PREMIUM_MONTHLY_PRODUCT_ID', 'PLAN_PREMIUM_MONTHLY_CENTS', 9700],
    ANNUAL: ['ABACATEPAY_PREMIUM_ANNUAL_PRODUCT_ID', 'PLAN_PREMIUM_ANNUAL_CENTS', 97000],
  },
  PRO_BUSINESS: {
    MONTHLY: ['ABACATEPAY_PRO_BUSINESS_MONTHLY_PRODUCT_ID', 'PLAN_PRO_BUSINESS_MONTHLY_CENTS', 19700],
    ANNUAL: ['ABACATEPAY_PRO_BUSINESS_ANNUAL_PRODUCT_ID', 'PLAN_PRO_BUSINESS_ANNUAL_CENTS', 197000],
  },
} as const;

function intEnv(key: string, fallback: number) {
  const parsed = Number(process.env[key]);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeBillingProvider() {
  const provider = String(process.env.BILLING_PAYMENT_PROVIDER || 'MANUAL').trim().toUpperCase();
  if (provider === 'CACTO') return 'CAKTO';
  if (['MANUAL', 'ABACATEPAY', 'CAKTO', 'ASAAS', 'MERCADO_PAGO'].includes(provider)) {
    return provider;
  }
  return 'MANUAL';
}

function providerPriceConfig(planKey: string, cycle: BillingCycle, productEnv: string) {
  const provider = normalizeBillingProvider();
  if (provider === 'CAKTO') {
    const prefix = `CAKTO_${planKey}_${cycle}`;
    return {
      provider,
      providerProductId: process.env[`${prefix}_PRODUCT_ID`] || null,
      providerOfferId: process.env[`${prefix}_OFFER_ID`] || null,
      providerCheckoutUrl: process.env[`${prefix}_CHECKOUT_URL`] || null,
      providerMetadata: {
        type: 'subscription',
        integrationStrategy: 'fixed_checkout_link',
      },
    };
  }

  if (provider === 'ABACATEPAY') {
    return {
      provider,
      providerProductId: process.env[productEnv] || null,
      providerOfferId: null,
      providerCheckoutUrl: null,
      providerMetadata: null,
    };
  }

  return {
    provider,
    providerProductId: null,
    providerOfferId: null,
    providerCheckoutUrl: null,
    providerMetadata: null,
  };
}

async function seedBillingPlans() {
  for (const definition of billingPlans) {
    const plan = await prisma.billingPlan.upsert({
      where: { key: definition.key },
      create: definition,
      update: {
        name: definition.name,
        description: definition.description,
        level: definition.level,
        features: definition.features,
        isActive: true,
      },
    });

    for (const cycle of [BillingCycle.MONTHLY, BillingCycle.ANNUAL]) {
      const [productEnv, amountEnv, fallback] = priceEnv[definition.key as keyof typeof priceEnv][cycle];
      const providerConfig = providerPriceConfig(definition.key, cycle, productEnv);
      await prisma.billingPlanPrice.upsert({
        where: { planId_billingCycle: { planId: plan.id, billingCycle: cycle } },
        create: {
          planId: plan.id,
          billingCycle: cycle,
          amountInCents: intEnv(amountEnv, fallback),
          ...providerConfig,
          abacatepayProductId: process.env[productEnv] || null,
        },
        update: {
          amountInCents: intEnv(amountEnv, fallback),
          ...providerConfig,
          abacatepayProductId: process.env[productEnv] || null,
          isActive: true,
        },
      });
    }
  }
}

async function main() {
  await seedBillingPlans();

  const company = await prisma.company.upsert({
    where: { slug: 'empresa-demo' },
    update: {},
    create: {
      name: 'Empresa Demo',
      slug: 'empresa-demo',
      currency: 'BRL',
      timezone: 'America/Sao_Paulo',
    },
  });

  await prisma.usageQuota.upsert({
    where: { companyId: company.id },
    update: {},
    create: {
      companyId: company.id,
      currentTier: 'COMUM',
      llmTokensUsed: 0,
      whatsappMessagesSent: 0,
      billingCycleEnd: new Date(new Date().setMonth(new Date().getMonth() + 1)),
    },
  });

  const hashedPassword = await bcrypt.hash('senha123', BCRYPT_ROUNDS);
  const adminUser = await prisma.user.upsert({
    where: { email: 'admin@empresa-demo.com' },
    update: {
      admin: true,
    },
    create: {
      email: 'admin@empresa-demo.com',
      password: hashedPassword,
      name: 'Admin Demo',
      admin: true,
      companyId: company.id,
    },
  });

  // Vendas de exemplo para o dashboard (hoje, ontem, semana, mês, ano) exibirem dados reais
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
  await prisma.sale.createMany({
    data: [
      { userId: adminUser.id, companyId: company.id, amount: 150.5, productName: 'Produto A', channel: 'manual', occurredAt: today },
      { userId: adminUser.id, companyId: company.id, amount: 89.0, productName: 'Produto B', channel: 'manual', occurredAt: yesterday },
      { userId: adminUser.id, companyId: company.id, amount: 320.0, productName: 'Produto C', category: 'E-commerce', channel: 'manual', occurredAt: new Date(today.getTime() - 3 * 24 * 60 * 60 * 1000) },
    ],
    skipDuplicates: true,
  });

  console.log('Seed concluído. Login: admin@empresa-demo.com / senha123');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
