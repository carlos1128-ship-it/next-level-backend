import { BillingCycle, Plan, PrismaClient, SubscriptionStatus } from '@prisma/client';

const prisma = new PrismaClient();
const PLAN_KEYS = ['COMMON', 'PREMIUM', 'PRO_BUSINESS'] as const;
const BILLING_CYCLES = [BillingCycle.MONTHLY, BillingCycle.ANNUAL] as const;
const ACTIVE_STATUSES = [SubscriptionStatus.ACTIVE, SubscriptionStatus.PAID];

function adminEmails() {
  return (process.env.BILLING_ADMIN_EMAILS || '')
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
}

function legacyGraceEnabled() {
  return String(process.env.BILLING_LEGACY_GRACE_ENABLED || '').trim().toLowerCase() === 'true';
}

async function ensurePlan(planKey: 'COMMON' | 'PREMIUM' | 'PRO_BUSINESS') {
  const labels = {
    COMMON: { name: 'Comum', description: 'Plano inicial.', level: 1 },
    PREMIUM: { name: 'Premium', description: 'Plano intermediario.', level: 2 },
    PRO_BUSINESS: { name: 'Pro Business', description: 'Plano completo.', level: 3 },
  }[planKey];

  return prisma.billingPlan.upsert({
    where: { key: planKey },
    create: {
      key: planKey,
      name: labels.name,
      description: labels.description,
      level: labels.level,
      features: [],
    },
    update: { isActive: true, level: labels.level },
  });
}

async function grantInternal(user: { id: string; companyId: string | null; plan: Plan }, source: 'ADMIN_GRANT' | 'INTERNAL_LEGACY', planKey: 'PREMIUM' | 'PRO_BUSINESS') {
  const billingPlan = await ensurePlan(planKey);
  const existing = await prisma.subscription.findFirst({
    where: { userId: user.id, source },
    orderBy: { createdAt: 'desc' },
  });

  const data = {
    companyId: user.companyId,
    billingPlanId: billingPlan.id,
    planKey,
    billingCycle: BillingCycle.MONTHLY,
    status: SubscriptionStatus.ACTIVE,
    provider: 'MANUAL',
    source,
    notes: source === 'ADMIN_GRANT' ? 'Admin/dev access grant' : 'Legacy user grace grant',
    amountInCents: 0,
    currency: 'BRL',
    paidAt: new Date(),
    currentPeriodStart: new Date(),
    currentPeriodEnd: null,
    expiresAt: null,
  };

  if (existing) {
    await prisma.subscription.update({ where: { id: existing.id }, data });
  } else {
    await prisma.subscription.create({ data: { ...data, userId: user.id } });
  }

  const legacyPlan = planKey === 'PRO_BUSINESS' ? Plan.ENTERPRISE : Plan.PRO;
  await prisma.user.update({ where: { id: user.id }, data: { plan: legacyPlan } });
  if (user.companyId) {
    await prisma.usageQuota.upsert({
      where: { companyId: user.companyId },
      create: {
        companyId: user.companyId,
        currentTier: legacyPlan,
        billingCycleEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        llmTokensUsed: 0,
        whatsappMessagesSent: 0,
      },
      update: { currentTier: legacyPlan },
    });
  }
}

async function main() {
  const shouldFix = process.argv.includes('--fix');
  const emails = adminEmails();

  const [planCount, priceCount, subscriptionsByStatus, subscriptionsByProvider, recentCaktoEvents, failedProcessingCount, unmatchedWebhookCount] = await Promise.all([
    prisma.billingPlan.count(),
    prisma.billingPlanPrice.count(),
    prisma.subscription.groupBy({ by: ['status'], _count: { _all: true } }),
    prisma.subscription.groupBy({ by: ['provider'], _count: { _all: true } }),
    prisma.paymentEvent.findMany({
      where: { provider: 'CAKTO' },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: {
        id: true,
        eventType: true,
        providerRawEventType: true,
        processed: true,
        processingError: true,
        createdAt: true,
      },
    }),
    prisma.paymentEvent.count({
      where: { provider: 'CAKTO', processingError: { not: null } },
    }),
    prisma.paymentEvent.count({
      where: {
        provider: 'CAKTO',
        processingError: { contains: 'Could not safely match Cakto webhook to local subscription' },
      },
    }),
  ]);

  const planMapping = [];
  for (const planKey of PLAN_KEYS) {
    const plan = await prisma.billingPlan.findUnique({
      where: { key: planKey },
      include: { prices: true },
    });
    for (const billingCycle of BILLING_CYCLES) {
      const price = plan?.prices.find((item) => item.billingCycle === billingCycle && item.provider === 'CAKTO');
      planMapping.push({
        planKey,
        billingCycle,
        exists: Boolean(price),
        amountInCents: price?.amountInCents ?? null,
        provider: price?.provider ?? null,
        checkoutUrlConfigured: Boolean(price?.providerCheckoutUrl),
        productId: price?.providerProductId ?? null,
        offerId: price?.providerOfferId ?? null,
      });
    }
  }

  const duplicatePrices = await prisma.billingPlanPrice.groupBy({
    by: ['planId', 'billingCycle'],
    _count: { _all: true },
    having: { planId: { _count: { gt: 1 } } },
  });

  const adminUsers = emails.length
    ? await prisma.user.findMany({
        where: { email: { in: emails } },
        select: { id: true, email: true, companyId: true, plan: true },
      })
    : [];

  const adminGrantStatus = [];
  for (const user of adminUsers) {
    const activeGrant = await prisma.subscription.findFirst({
      where: {
        userId: user.id,
        source: 'ADMIN_GRANT',
        status: { in: ACTIVE_STATUSES },
      },
      orderBy: { createdAt: 'desc' },
    });
    adminGrantStatus.push({ email: user.email, hasAdminGrant: Boolean(activeGrant) });
    if (shouldFix && !activeGrant) {
      await grantInternal(user, 'ADMIN_GRANT', 'PRO_BUSINESS');
    }
  }

  const legacyUsers = await prisma.user.findMany({
    where: { plan: { in: [Plan.ENTERPRISE, Plan.PRO] } },
    select: { id: true, email: true, companyId: true, plan: true },
  });
  const legacyWithoutActive = [];
  for (const user of legacyUsers) {
    const activeSubscription = await prisma.subscription.findFirst({
      where: { userId: user.id, status: { in: ACTIVE_STATUSES } },
      orderBy: { createdAt: 'desc' },
    });
    if (!activeSubscription) {
      legacyWithoutActive.push({ email: user.email, plan: user.plan });
      if (shouldFix && legacyGraceEnabled()) {
        await grantInternal(user, 'INTERNAL_LEGACY', user.plan === Plan.ENTERPRISE ? 'PRO_BUSINESS' : 'PREMIUM');
      }
    }
  }

  console.log(
    JSON.stringify(
      {
        fixed: shouldFix,
        billingPlanCount: planCount,
        billingPlanPriceCount: priceCount,
        caktoPlanMapping: planMapping,
        missingCheckoutUrls: planMapping.filter((item) => !item.checkoutUrlConfigured),
        duplicatePlanPrices: duplicatePrices,
        subscriptionsByStatus,
        subscriptionsByProvider,
        adminGrantStatus,
        legacyWithoutActive,
        recentCaktoEvents,
        failedProcessingCount,
        unmatchedWebhookCount,
      },
      null,
      2,
    ),
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
