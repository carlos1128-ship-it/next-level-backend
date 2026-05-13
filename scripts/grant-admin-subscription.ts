import { BillingCycle, Plan, Prisma, PrismaClient, SubscriptionStatus } from '@prisma/client';

const prisma = new PrismaClient();
const PLAN_KEY = 'PRO_BUSINESS';
const GRANT_SOURCE = 'ADMIN_GRANT';
const DEFAULT_GRANT_DAYS = 180;

const userSelect = {
  id: true,
  email: true,
  companyId: true,
  admin: true,
  plan: true,
  name: true,
} satisfies Prisma.UserSelect;

const companySelect = {
  id: true,
  name: true,
  userId: true,
  users: {
    select: userSelect,
    orderBy: { createdAt: 'asc' as const },
  },
} satisfies Prisma.CompanySelect;

type ScriptUser = Prisma.UserGetPayload<{ select: typeof userSelect }>;
type ScriptCompany = Prisma.CompanyGetPayload<{ select: typeof companySelect }>;

async function ensureProBusinessPlan() {
  return prisma.billingPlan.upsert({
    where: { key: PLAN_KEY },
    create: {
      key: PLAN_KEY,
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

function readAdminEmail() {
  return (process.env.ADMIN_EMAIL || process.argv[2] || '').trim().toLowerCase();
}

function readAdminCompanyId() {
  return (process.env.ADMIN_COMPANY_ID || process.argv[3] || '').trim();
}

function resolveGrantDays() {
  const parsed = Number(process.env.ADMIN_GRANT_DAYS || DEFAULT_GRANT_DAYS);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_GRANT_DAYS;
}

function addDays(date: Date, days: number) {
  const clone = new Date(date);
  clone.setUTCDate(clone.getUTCDate() + days);
  return clone;
}

async function findCompanyForUser(user: ScriptUser) {
  if (user.companyId) {
    return prisma.company.findUnique({
      where: { id: user.companyId },
      select: companySelect,
    });
  }

  return prisma.company.findFirst({
    where: { userId: user.id },
    select: companySelect,
  });
}

function pickCompanyUser(company: ScriptCompany) {
  return (
    company.users.find((user) => user.id === company.userId) ||
    company.users.find((user) => user.admin) ||
    company.users[0] ||
    null
  );
}

function assertUserBelongsToCompany(user: ScriptUser, company: ScriptCompany) {
  const belongs =
    user.companyId === company.id ||
    company.userId === user.id ||
    company.users.some((companyUser) => companyUser.id === user.id);

  if (!belongs) {
    throw new Error(
      `ADMIN_EMAIL ${user.email} nao pertence a ADMIN_COMPANY_ID ${company.id}`,
    );
  }
}

async function resolveTarget() {
  const email = readAdminEmail();
  const companyId = readAdminCompanyId();

  if (!email && !companyId) {
    throw new Error(
      'Informe ADMIN_EMAIL ou ADMIN_COMPANY_ID. Ex: ADMIN_EMAIL=admin@email.com npm run admin:promote-pro-business',
    );
  }

  const user = email
    ? await prisma.user.findUnique({
        where: { email },
        select: userSelect,
      })
    : null;

  if (email && !user) {
    throw new Error(`Usuario nao encontrado: ${email}`);
  }

  const company = companyId
    ? await prisma.company.findUnique({
        where: { id: companyId },
        select: companySelect,
      })
    : user
      ? await findCompanyForUser(user)
      : null;

  if (companyId && !company) {
    throw new Error(`Empresa nao encontrada: ${companyId}`);
  }

  if (!company) {
    throw new Error(
      `Empresa nao encontrada para ${email || companyId}. Informe ADMIN_COMPANY_ID se necessario.`,
    );
  }

  if (user) {
    assertUserBelongsToCompany(user, company);
  }

  const targetUser = user || pickCompanyUser(company);
  if (!targetUser) {
    throw new Error(`Nenhum usuario encontrado para a empresa ${company.id}`);
  }

  return {
    user: targetUser,
    company,
  };
}

async function main() {
  const { user, company } = await resolveTarget();
  const plan = await ensureProBusinessPlan();
  const now = new Date();
  const grantDays = resolveGrantDays();
  const periodEnd = addDays(now, grantDays);
  const existing = await prisma.subscription.findFirst({
    where: { userId: user.id, source: GRANT_SOURCE },
    orderBy: { createdAt: 'desc' },
  });

  const data = {
    companyId: company.id,
    billingPlanId: plan.id,
    planKey: PLAN_KEY,
    billingCycle: BillingCycle.MONTHLY,
    status: SubscriptionStatus.ACTIVE,
    provider: 'MANUAL',
    source: GRANT_SOURCE,
    amountInCents: 0,
    currency: 'BRL',
    paidAt: now,
    currentPeriodStart: now,
    currentPeriodEnd: periodEnd,
    expiresAt: periodEnd,
    notes: 'Admin/dev access grant for Pro Business testing',
    metadata: {
      source: GRANT_SOURCE,
      reason: 'pro_business_test_access',
      grantedBy: 'grant-admin-subscription',
      grantDays,
      grantedAt: now.toISOString(),
    } as Prisma.InputJsonValue,
    createdAt: now,
  };

  const subscription = existing
    ? await prisma.subscription.update({ where: { id: existing.id }, data })
    : await prisma.subscription.create({ data: { ...data, userId: user.id } });

  await prisma.user.update({
    where: { id: user.id },
    data: { plan: Plan.ENTERPRISE },
  });

  await prisma.usageQuota.upsert({
    where: { companyId: company.id },
    create: {
      companyId: company.id,
      currentTier: Plan.ENTERPRISE,
      billingCycleEnd: periodEnd,
      llmTokensUsed: 0,
      whatsappMessagesSent: 0,
    },
    update: {
      currentTier: Plan.ENTERPRISE,
      billingCycleEnd: periodEnd,
    },
  });

  console.log(
    JSON.stringify(
      {
        ok: true,
        email: user.email,
        companyId: company.id,
        companyName: company.name,
        subscriptionId: subscription.id,
        planKey: subscription.planKey,
        status: subscription.status,
        provider: subscription.provider,
        source: subscription.source,
        currentPeriodEnd: subscription.currentPeriodEnd,
        expiresAt: subscription.expiresAt,
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
