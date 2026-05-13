import { BillingCycle, Plan, Prisma, PrismaClient, SubscriptionStatus } from '@prisma/client';

const prisma = new PrismaClient();
const PLAN_KEY = 'PRO_BUSINESS';
const SOURCE = 'ADMIN_PRO_BUSINESS_GRANT';
const DEFAULT_DAYS = 365;

const userSelect = {
  id: true,
  email: true,
  companyId: true,
  admin: true,
  plan: true,
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

function envValue(name: string) {
  return (process.env[name] || '').trim();
}

function addDays(date: Date, days: number) {
  const copy = new Date(date);
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

function grantDays() {
  const value = Number(envValue('ADMIN_GRANT_DAYS') || DEFAULT_DAYS);
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_DAYS;
}

async function ensurePlan() {
  return prisma.billingPlan.upsert({
    where: { key: PLAN_KEY },
    create: {
      key: PLAN_KEY,
      name: 'Pro Business',
      description: 'Plano completo para automacao, marketplaces e escala.',
      level: 3,
      features: [],
      isActive: true,
    },
    update: { level: 3, isActive: true },
  });
}

async function findCompanyFromUser(user: ScriptUser) {
  if (user.companyId) {
    return prisma.company.findUnique({ where: { id: user.companyId }, select: companySelect });
  }
  return prisma.company.findFirst({ where: { userId: user.id }, select: companySelect });
}

function pickCompanyUser(company: ScriptCompany) {
  return company.users.find((user) => user.id === company.userId) || company.users.find((user) => user.admin) || company.users[0] || null;
}

function assertMembership(user: ScriptUser, company: ScriptCompany) {
  const belongs = user.companyId === company.id || company.userId === user.id || company.users.some((item) => item.id === user.id);
  if (!belongs) {
    throw new Error(`ADMIN_EMAIL ${user.email} nao pertence a ADMIN_COMPANY_ID ${company.id}`);
  }
}

async function resolveTarget() {
  const adminEmail = envValue('ADMIN_EMAIL').toLowerCase();
  const adminCompanyId = envValue('ADMIN_COMPANY_ID');

  if (!adminEmail && !adminCompanyId) {
    throw new Error('Informe ADMIN_EMAIL ou ADMIN_COMPANY_ID.');
  }

  const user = adminEmail ? await prisma.user.findUnique({ where: { email: adminEmail }, select: userSelect }) : null;
  if (adminEmail && !user) {
    throw new Error(`Usuario nao encontrado: ${adminEmail}`);
  }

  const company = adminCompanyId
    ? await prisma.company.findUnique({ where: { id: adminCompanyId }, select: companySelect })
    : user
      ? await findCompanyFromUser(user)
      : null;

  if (adminCompanyId && !company) {
    throw new Error(`Empresa nao encontrada: ${adminCompanyId}`);
  }
  if (!company) {
    throw new Error(`Empresa nao encontrada para ${adminEmail || adminCompanyId}`);
  }
  if (user) {
    assertMembership(user, company);
  }

  const targetUser = user || pickCompanyUser(company);
  if (!targetUser) {
    throw new Error(`Nenhum usuario encontrado para a empresa ${company.id}`);
  }

  return { user: targetUser, company };
}

async function main() {
  const { user, company } = await resolveTarget();
  const plan = await ensurePlan();
  const now = new Date();
  const periodEnd = addDays(now, grantDays());

  const existing = await prisma.subscription.findFirst({
    where: {
      companyId: company.id,
      OR: [{ userId: user.id }, { source: SOURCE }],
    },
    orderBy: { createdAt: 'desc' },
  });

  const data = {
    userId: user.id,
    companyId: company.id,
    billingPlanId: plan.id,
    planKey: PLAN_KEY,
    billingCycle: BillingCycle.MONTHLY,
    status: SubscriptionStatus.ACTIVE,
    provider: 'MANUAL',
    source: SOURCE,
    amountInCents: 0,
    currency: 'BRL',
    paidAt: now,
    currentPeriodStart: now,
    currentPeriodEnd: periodEnd,
    expiresAt: periodEnd,
    notes: 'Promocao segura de admin para Pro Business.',
    metadata: {
      source: SOURCE,
      adminEmail: user.email,
      companyId: company.id,
      grantedAt: now.toISOString(),
    } as Prisma.InputJsonValue,
  };

  const subscription = existing
    ? await prisma.subscription.update({ where: { id: existing.id }, data })
    : await prisma.subscription.create({ data });

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
        planKey: subscription.planKey,
        status: subscription.status,
        subscriptionId: subscription.id,
        currentPeriodEnd: subscription.currentPeriodEnd,
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
