import { PrismaClient, FinancialTransactionType, LeadStatus, SaleAIAttributionSource } from '@prisma/client';
import { DashboardService } from '../src/modules/dashboard/dashboard.service';
import { AttendantService } from '../src/modules/attendant/attendant.service';

const prisma = new PrismaClient();
const RealDate = Date;
const fixedNow = new RealDate('2026-05-20T15:00:00-03:00');
const slugs = [
  'dashboard-validation-company-a',
  'dashboard-validation-company-b',
  'dashboard-validation-company-empty',
];
const emails = [
  'dashboard-validation-a@nextlevel.local',
  'dashboard-validation-b@nextlevel.local',
  'dashboard-validation-empty@nextlevel.local',
];
const metricKeys = [
  'revenue',
  'losses',
  'net_profit',
  'cash_flow',
  'company_count',
  'income_revenue',
  'average_ticket',
  'operational_costs',
  'margin',
  'waste_inefficiency',
  'cash_flow_summary',
  'category_mix',
].join(',');

function assert(condition: unknown, message: string) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertClose(actual: number | null | undefined, expected: number, label: string) {
  assert(typeof actual === 'number', `${label}: valor nao numerico`);
  assert(Math.abs(Number(actual) - expected) < 0.01, `${label}: esperado ${expected}, atual ${actual}`);
}

function installFixedNow() {
  class FixedDate extends RealDate {
    constructor(...args: any[]) {
      if (args.length === 0) {
        super(fixedNow.getTime());
      } else {
        super(...(args as [any]));
      }
    }

    static now() {
      return fixedNow.getTime();
    }
  }

  global.Date = FixedDate as DateConstructor;
}

function restoreDate() {
  global.Date = RealDate;
}

function daysAgo(days: number, hour = 12) {
  const date = new RealDate(fixedNow);
  date.setDate(date.getDate() - days);
  date.setHours(hour, 0, 0, 0);
  return date;
}

async function resetControlledData() {
  await prisma.company.deleteMany({ where: { slug: { in: slugs } } });
  await prisma.user.deleteMany({ where: { email: { in: emails } } });
}

async function createCompany(email: string, slug: string, name: string) {
  const user = await prisma.user.create({
    data: {
      email,
      password: 'dashboard-validation-only',
      name,
      plan: 'PRO',
    },
  });
  const company = await prisma.company.create({
    data: {
      name,
      slug,
      userId: user.id,
      timezone: 'America/Sao_Paulo',
      currency: 'BRL',
    },
  });
  await prisma.user.update({
    where: { id: user.id },
    data: { companyId: company.id },
  });

  return { user, company };
}

async function seedData() {
  await resetControlledData();

  const companyA = await createCompany(emails[0], slugs[0], 'Dashboard Validation A');
  const companyB = await createCompany(emails[1], slugs[1], 'Dashboard Validation B');
  const empty = await createCompany(emails[2], slugs[2], 'Dashboard Validation Empty');

  await prisma.product.createMany({
    data: [
      { companyId: companyA.company.id, name: 'Produto A', sku: 'A-001', category: 'Validacao', price: 500, cost: 0 },
      { companyId: companyB.company.id, name: 'Produto B', sku: 'B-001', category: 'Validacao', price: 1000, cost: 0 },
    ],
  });

  const [saleA1, saleA2, saleB1] = await Promise.all([
    prisma.sale.create({
      data: { userId: companyA.user.id, companyId: companyA.company.id, amount: 400, productName: 'Produto A', category: 'Linha A', occurredAt: daysAgo(0, 10) },
    }),
    prisma.sale.create({
      data: { userId: companyA.user.id, companyId: companyA.company.id, amount: 600, productName: 'Produto A', category: 'Linha A', occurredAt: daysAgo(0, 14) },
    }),
    prisma.sale.create({
      data: { userId: companyB.user.id, companyId: companyB.company.id, amount: 2000, productName: 'Produto B', category: 'Linha B', occurredAt: daysAgo(0, 11) },
    }),
  ]);
  await prisma.sale.createMany({
    data: [
      { userId: companyA.user.id, companyId: companyA.company.id, amount: 200, productName: 'Produto A', category: 'Linha A', occurredAt: daysAgo(1, 11) },
      { userId: companyA.user.id, companyId: companyA.company.id, amount: 300, productName: 'Produto A', category: 'Linha A', occurredAt: daysAgo(10, 11) },
    ],
  });

  await prisma.financialTransaction.createMany({
    data: [
      { userId: companyA.user.id, companyId: companyA.company.id, type: FinancialTransactionType.EXPENSE, amount: 50, description: 'Perda operacional A', category: 'Perdas', occurredAt: daysAgo(0, 13) },
      { userId: companyA.user.id, companyId: companyA.company.id, type: FinancialTransactionType.EXPENSE, amount: 20, description: 'Perda anterior A', category: 'Perdas', occurredAt: daysAgo(1, 13) },
      { userId: companyB.user.id, companyId: companyB.company.id, type: FinancialTransactionType.EXPENSE, amount: 100, description: 'Perda operacional B', category: 'Perdas', occurredAt: daysAgo(0, 13) },
    ],
  });

  await prisma.operationalCost.createMany({
    data: [
      { companyId: companyA.company.id, name: 'Custo operacional A', category: 'Operacao', amount: 300, date: daysAgo(0, 9) },
      { companyId: companyA.company.id, name: 'Custo anterior A', category: 'Operacao', amount: 30, date: daysAgo(1, 9) },
      { companyId: companyA.company.id, name: 'Custo mensal A', category: 'Operacao', amount: 40, date: daysAgo(10, 9) },
      { companyId: companyB.company.id, name: 'Custo operacional B', category: 'Operacao', amount: 400, date: daysAgo(0, 9) },
    ],
  });

  await prisma.lead.createMany({
    data: [
      { companyId: companyA.company.id, externalId: 'lead-a-1', status: LeadStatus.CONVERTED, lastQuotedValue: 700 },
      { companyId: companyA.company.id, externalId: 'lead-a-2', status: LeadStatus.CONVERTED, lastQuotedValue: 150 },
      { companyId: companyB.company.id, externalId: 'lead-b-1', status: LeadStatus.CONVERTED, lastQuotedValue: 300 },
    ],
  });

  const conversationA = await prisma.conversation.create({
    data: {
      companyId: companyA.company.id,
      contactNumber: '5511999990001',
      status: 'IA respondeu',
      lastMessageAt: daysAgo(0, 10),
    },
  });
  const conversationB = await prisma.conversation.create({
    data: {
      companyId: companyB.company.id,
      contactNumber: '5511999990002',
      status: 'IA respondeu',
      lastMessageAt: daysAgo(0, 11),
    },
  });
  const [messageA, messageB] = await Promise.all([
    prisma.message.create({
      data: {
        companyId: companyA.company.id,
        conversationId: conversationA.id,
        role: 'assistant',
        direction: 'outbound',
        content: 'Fechamos seu pedido A.',
        status: 'sent',
      },
    }),
    prisma.message.create({
      data: {
        companyId: companyB.company.id,
        conversationId: conversationB.id,
        role: 'assistant',
        direction: 'outbound',
        content: 'Fechamos seu pedido B.',
        status: 'sent',
      },
    }),
  ]);
  await prisma.saleAIAttribution.createMany({
    data: [
      {
        companyId: companyA.company.id,
        saleId: saleA1.id,
        conversationId: conversationA.id,
        messageId: messageA.id,
        source: SaleAIAttributionSource.WHATSAPP_AGENT,
        attributedRevenue: 700,
        confidence: 1,
        occurredAt: saleA1.occurredAt,
      },
      {
        companyId: companyA.company.id,
        saleId: saleA2.id,
        conversationId: conversationA.id,
        messageId: messageA.id,
        source: SaleAIAttributionSource.WHATSAPP_AGENT,
        attributedRevenue: 150,
        confidence: 0.7,
        occurredAt: saleA2.occurredAt,
      },
      {
        companyId: companyB.company.id,
        saleId: saleB1.id,
        conversationId: conversationB.id,
        messageId: messageB.id,
        source: SaleAIAttributionSource.WHATSAPP_AGENT,
        attributedRevenue: 300,
        confidence: 1,
        occurredAt: saleB1.occurredAt,
      },
    ],
  });

  return { companyA, companyB, empty };
}

async function main() {
  if (process.env.NODE_ENV === 'production' && process.env.DASHBOARD_METRICS_TEST_ALLOW_PRODUCTION !== '1') {
    throw new Error('Recusado em production. Defina DASHBOARD_METRICS_TEST_ALLOW_PRODUCTION=1 para executar conscientemente.');
  }

  installFixedNow();
  const { companyA, companyB, empty } = await seedData();
  const dashboard = new DashboardService(prisma as any);
  const attendant = new AttendantService(
    prisma as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
  );

  const aToday = await dashboard.getMetrics(companyA.user.id, undefined, 'today', metricKeys, false, undefined, undefined, companyA.company.id);
  const bToday = await dashboard.getMetrics(companyB.user.id, undefined, 'today', metricKeys, false, undefined, undefined, companyB.company.id);
  const aSummary = await dashboard.getSummary(companyA.user.id, companyA.company.id, 'today', metricKeys);
  const bSummary = await dashboard.getSummary(companyB.user.id, companyB.company.id, 'today', metricKeys);

  assertClose(aToday.metrics.revenue.value, 1000, 'A/D. Faturamento Empresa A');
  assertClose(aToday.metrics.losses.value, 350, 'A/E. Perdas Empresa A');
  assertClose(aToday.metrics.net_profit.value, 650, 'A/F. Lucro liquido Empresa A');
  assertClose(aToday.metrics.cash_flow.value, 650, 'A/G. Fluxo de caixa Empresa A');
  assertClose(aToday.metrics.average_ticket.value, 500, 'A/H. Ticket medio Empresa A');
  assertClose(aToday.metrics.operational_costs.value, 300, 'A/I. Custos operacionais Empresa A');
  assertClose(aToday.metrics.margin.value, 65, 'A/J. Margem Empresa A');
  assertClose(aToday.metrics.waste_inefficiency.value, 30, 'A/K. Desperdicio Empresa A');
  assertClose(aSummary.revenue, 1000, 'Summary Empresa A faturamento');
  assertClose(aSummary.losses, 350, 'Summary Empresa A perdas');
  assertClose(aSummary.profit, 650, 'Summary Empresa A lucro');

  assertClose(bToday.metrics.revenue.value, 2000, 'B. Faturamento Empresa B');
  assertClose(bToday.metrics.losses.value, 500, 'B. Perdas Empresa B');
  assertClose(bToday.metrics.net_profit.value, 1500, 'B. Lucro Empresa B');
  assertClose(bSummary.revenue, 2000, 'Summary Empresa B faturamento');
  assertClose(bSummary.losses, 500, 'Summary Empresa B perdas');

  assert(
    aToday.charts.revenueByDay.some((point) => Number(point.Receitas) === 1000 && Number(point.Saidas) === 350),
    'Fluxo por faixa da Empresa A nao refletiu receitas/saidas reais',
  );
  assert(
    aToday.charts.salesByProduct.length === 1 &&
      aToday.charts.salesByProduct[0].name === 'Produto A' &&
      Number(aToday.charts.salesByProduct[0].revenue) === 1000,
    'Mix do periodo da Empresa A vazou ou calculou produto errado',
  );

  let blockedStatus = 0;
  try {
    await dashboard.getMetrics(companyA.user.id, companyB.company.id, 'today', metricKeys, false, undefined, undefined, companyA.company.id, false);
  } catch (error: any) {
    blockedStatus = typeof error?.getStatus === 'function' ? error.getStatus() : 0;
  }
  assert(blockedStatus === 403, 'C. Manipulacao de companyId nao retornou 403');

  const aWeek = await dashboard.getMetrics(companyA.user.id, undefined, 'week', 'revenue,losses', false, undefined, undefined, companyA.company.id);
  const aMonth = await dashboard.getMetrics(companyA.user.id, undefined, 'month', 'revenue,losses', false, undefined, undefined, companyA.company.id);
  assertClose(aWeek.metrics.revenue.value, 1200, 'L. Week faturamento Empresa A');
  assertClose(aMonth.metrics.revenue.value, 1500, 'L. Month faturamento Empresa A');
  assert(aToday.metrics.revenue.value !== aWeek.metrics.revenue.value && aWeek.metrics.revenue.value !== aMonth.metrics.revenue.value, 'L. Filtros today/week/month nao mudaram os valores');

  const emptyMetrics = await dashboard.getMetrics(empty.user.id, undefined, 'today', metricKeys, false, undefined, undefined, empty.company.id);
  ['revenue', 'losses', 'net_profit', 'cash_flow', 'operational_costs'].forEach((key) => {
    const item = emptyMetrics.metrics[key];
    assert(item.value === 0 && item.status === 'ok' && item.formatted.includes('0,00'), `M. ${key} vazio deve voltar R$ 0,00`);
  });
  ['average_ticket', 'margin', 'waste_inefficiency'].forEach((key) => {
    const item = emptyMetrics.metrics[key];
    assert(item.value === null && item.status === 'not_enough_data' && item.formatted === 'Dados insuficientes', `N. ${key} vazio deve voltar Dados insuficientes`);
  });

  const roiA = await attendant.getRoi(companyA.company.id);
  const roiB = await attendant.getRoi(companyB.company.id);
  assert(roiA.iaSalesCount === 2 && roiA.iaRevenue === 850, 'ROI da IA Empresa A nao usou leads convertidos reais');
  assert(roiB.iaSalesCount === 1 && roiB.iaRevenue === 300, 'ROI da IA Empresa B nao ficou isolado');

  console.log(
    JSON.stringify(
      {
        status: 'Dashboard metrics checks A-N passed',
        fixedNow: fixedNow.toISOString(),
        companies: {
          A: { companyId: companyA.company.id, expected: { revenue: 1000, losses: 350, profit: 650, cashFlow: 650, averageTicket: 500, operationalCosts: 300, margin: 65, waste: 30, aiRevenue: 850 } },
          B: { companyId: companyB.company.id, expected: { revenue: 2000, losses: 500, profit: 1500, cashFlow: 1500, averageTicket: 2000, operationalCosts: 400, margin: 75, waste: 20, aiRevenue: 300 } },
          empty: { companyId: empty.company.id, expected: { money: 0, derived: 'Dados insuficientes' } },
        },
      },
      null,
      2,
    ),
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    restoreDate();
    await prisma.$disconnect();
  });
