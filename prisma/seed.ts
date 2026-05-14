import { AIUsageFeature, BillingCycle, PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();
const BCRYPT_ROUNDS = Number(process.env.BCRYPT_ROUNDS || 12);

const billingPlans = [
  {
    key: 'COMMON',
    name: 'Essencial',
    description: 'Plano inicial para organizar dados, acompanhar indicadores e usar IA basica sem integracoes automaticas.',
    level: 1,
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
  },
  {
    key: 'PREMIUM',
    name: 'Premium',
    description: 'Plano para empresas que querem usar IA, atendimento automatico e integracoes principais para crescer com mais clareza.',
    level: 2,
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
  },
  {
    key: 'PRO_BUSINESS',
    name: 'Pro Business',
    description: 'Plano completo para automacao, inteligencia de mercado e previsoes.',
    level: 3,
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
  },
];

const priceEnv = {
  COMMON: {
    MONTHLY: ['STRIPE_PRICE_ESSENTIAL_MONTHLY', 'PLAN_COMMON_MONTHLY_CENTS', 5700],
    ANNUAL: ['STRIPE_PRICE_ESSENTIAL_YEARLY', 'PLAN_COMMON_ANNUAL_CENTS', 57000],
  },
  PREMIUM: {
    MONTHLY: ['STRIPE_PRICE_PREMIUM_MONTHLY', 'PLAN_PREMIUM_MONTHLY_CENTS', 9700],
    ANNUAL: ['STRIPE_PRICE_PREMIUM_YEARLY', 'PLAN_PREMIUM_ANNUAL_CENTS', 97000],
  },
  PRO_BUSINESS: {
    MONTHLY: ['STRIPE_PRICE_PRO_BUSINESS_MONTHLY', 'PLAN_PRO_BUSINESS_MONTHLY_CENTS', 19700],
    ANNUAL: ['STRIPE_PRICE_PRO_BUSINESS_YEARLY', 'PLAN_PRO_BUSINESS_ANNUAL_CENTS', 197000],
  },
} as const;

const aiUsageLimits = [
  { planKey: 'common', feature: AIUsageFeature.CHAT_IA, monthlyRequestLimit: 400, enabled: true },
  { planKey: 'common', feature: AIUsageFeature.WHATSAPP_AGENT, monthlyRequestLimit: 0, enabled: false },
  { planKey: 'common', feature: AIUsageFeature.INSTAGRAM_AGENT, monthlyRequestLimit: 0, enabled: false },
  { planKey: 'common', feature: AIUsageFeature.INTELLIGENT_IMPORT, monthlyRequestLimit: 30, enabled: true },
  { planKey: 'basic', feature: AIUsageFeature.CHAT_IA, monthlyRequestLimit: 400, enabled: true },
  { planKey: 'basic', feature: AIUsageFeature.WHATSAPP_AGENT, monthlyRequestLimit: 0, enabled: false },
  { planKey: 'basic', feature: AIUsageFeature.INSTAGRAM_AGENT, monthlyRequestLimit: 0, enabled: false },
  { planKey: 'basic', feature: AIUsageFeature.INTELLIGENT_IMPORT, monthlyRequestLimit: 30, enabled: true },
  { planKey: 'premium', feature: AIUsageFeature.CHAT_IA, monthlyRequestLimit: 1000, enabled: true },
  { planKey: 'premium', feature: AIUsageFeature.WHATSAPP_AGENT, monthlyRequestLimit: 3000, enabled: true },
  { planKey: 'premium', feature: AIUsageFeature.INSTAGRAM_AGENT, monthlyRequestLimit: 3000, enabled: true },
  { planKey: 'premium', feature: AIUsageFeature.INTELLIGENT_IMPORT, monthlyRequestLimit: 240, enabled: true },
  { planKey: 'pro_business', feature: AIUsageFeature.CHAT_IA, monthlyRequestLimit: 5000, enabled: true },
  { planKey: 'pro_business', feature: AIUsageFeature.WHATSAPP_AGENT, monthlyRequestLimit: 10000, enabled: true },
  { planKey: 'pro_business', feature: AIUsageFeature.INSTAGRAM_AGENT, monthlyRequestLimit: 10000, enabled: true },
  { planKey: 'pro_business', feature: AIUsageFeature.INTELLIGENT_IMPORT, monthlyRequestLimit: null, enabled: true },
  { planKey: 'business', feature: AIUsageFeature.CHAT_IA, monthlyRequestLimit: 5000, enabled: true },
  { planKey: 'business', feature: AIUsageFeature.WHATSAPP_AGENT, monthlyRequestLimit: 10000, enabled: true },
  { planKey: 'business', feature: AIUsageFeature.INSTAGRAM_AGENT, monthlyRequestLimit: 10000, enabled: true },
  { planKey: 'business', feature: AIUsageFeature.INTELLIGENT_IMPORT, monthlyRequestLimit: null, enabled: true },
] as const;

function intEnv(key: string, fallback: number) {
  const parsed = Number(process.env[key]);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeBillingProvider() {
  return 'STRIPE';
}

function providerPriceConfig(planKey: string, cycle: BillingCycle, productEnv: string) {
  const provider = normalizeBillingProvider();
  return {
    provider,
    providerProductId: process.env[productEnv] || null,
    providerOfferId: null,
    providerCheckoutUrl: null,
    providerMetadata: { app: 'next_level_ai', planKey, cycle },
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
          stripePriceId: process.env[productEnv] || null,
        },
        update: {
          amountInCents: intEnv(amountEnv, fallback),
          ...providerConfig,
          stripePriceId: process.env[productEnv] || null,
          isActive: true,
        },
      });
    }
  }
}

async function seedAiUsageLimits() {
  for (const limit of aiUsageLimits) {
    await prisma.aIUsageLimit.upsert({
      where: {
        planKey_feature: {
          planKey: limit.planKey,
          feature: limit.feature,
        },
      },
      create: {
        planKey: limit.planKey,
        feature: limit.feature,
        monthlyRequestLimit: limit.monthlyRequestLimit,
        monthlyTokenLimit: null,
        enabled: limit.enabled,
      },
      update: {
        monthlyRequestLimit: limit.monthlyRequestLimit,
        monthlyTokenLimit: null,
        enabled: limit.enabled,
      },
    });
  }
}

async function main() {
  await seedBillingPlans();
  await seedAiUsageLimits();

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
