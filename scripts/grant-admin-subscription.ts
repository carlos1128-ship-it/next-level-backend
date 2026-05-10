import { BillingCycle, Plan, PrismaClient, SubscriptionStatus } from '@prisma/client';

const prisma = new PrismaClient();

async function ensureProBusinessPlan() {
  return prisma.billingPlan.upsert({
    where: { key: 'PRO_BUSINESS' },
    create: {
      key: 'PRO_BUSINESS',
      name: 'Pro Business',
      description: 'Plano completo para automacao, market intelligence e recursos avancados.',
      level: 3,
      features: [],
    },
    update: {
      isActive: true,
      level: 3,
    },
  });
}

async function main() {
  const email = process.argv[2]?.trim().toLowerCase();
  if (!email) {
    throw new Error('Uso: npx tsx scripts/grant-admin-subscription.ts admin@email.com');
  }

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true, companyId: true },
  });

  if (!user) {
    throw new Error(`Usuario nao encontrado: ${email}`);
  }

  const plan = await ensureProBusinessPlan();
  const existing = await prisma.subscription.findFirst({
    where: { userId: user.id, source: 'ADMIN_GRANT' },
    orderBy: { createdAt: 'desc' },
  });

  const data = {
    companyId: user.companyId,
    billingPlanId: plan.id,
    planKey: 'PRO_BUSINESS',
    billingCycle: BillingCycle.MONTHLY,
    status: SubscriptionStatus.ACTIVE,
    provider: 'MANUAL',
    source: 'ADMIN_GRANT',
    amountInCents: 0,
    currency: 'BRL',
    paidAt: new Date(),
    currentPeriodStart: new Date(),
    currentPeriodEnd: null,
    expiresAt: null,
    notes: 'Admin/dev access grant',
  };

  const subscription = existing
    ? await prisma.subscription.update({ where: { id: existing.id }, data })
    : await prisma.subscription.create({ data: { ...data, userId: user.id } });

  await prisma.user.update({
    where: { id: user.id },
    data: { plan: Plan.ENTERPRISE },
  });

  if (user.companyId) {
    await prisma.usageQuota.upsert({
      where: { companyId: user.companyId },
      create: {
        companyId: user.companyId,
        currentTier: Plan.ENTERPRISE,
        billingCycleEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        llmTokensUsed: 0,
        whatsappMessagesSent: 0,
      },
      update: { currentTier: Plan.ENTERPRISE },
    });
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        email: user.email,
        subscriptionId: subscription.id,
        planKey: subscription.planKey,
        status: subscription.status,
        provider: subscription.provider,
        source: subscription.source,
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
