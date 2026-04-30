import { DashboardService } from '../src/modules/dashboard/dashboard.service';
import {
  CORE_DASHBOARD_METRIC_KEYS,
  DASHBOARD_METRICS,
} from '../src/modules/dashboard/dashboard-metrics.registry';
import { CompanyPersonalizationService } from '../src/modules/company-personalization/company-personalization.service';

type Preference = {
  companyId: string;
  userId: string | null;
  metricKey: string;
  enabled: boolean;
  order: number;
  size: string | null;
};

const core = CORE_DASHBOARD_METRIC_KEYS;
const coreSet = new Set(core);
const expectedCore = [
  'revenue',
  'losses',
  'net_profit',
  'company_count',
  'cash_flow',
  'ai_roi',
  'income_revenue',
  'average_ticket',
  'operational_costs',
  'margin',
  'waste_inefficiency',
  'cash_flow_summary',
  'category_mix',
];

function assert(condition: unknown, message: string) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertSameArray(actual: string[], expected: string[], message: string) {
  assert(
    actual.length === expected.length && actual.every((item, index) => item === expected[index]),
    `${message}. Esperado: ${expected.join(', ')}. Atual: ${actual.join(', ')}`,
  );
}

function todayAt(hour: number) {
  const date = new Date();
  date.setHours(hour, 0, 0, 0);
  return date;
}

function daysAgo(days: number, hour: number) {
  const date = todayAt(hour);
  date.setDate(date.getDate() - days);
  return date;
}

function createFakePrisma() {
  const state = {
    users: [
      { id: 'user-a', email: 'a@test.local', companyId: 'company-a', plan: 'PRO', niche: null },
      { id: 'user-b', email: 'b@test.local', companyId: 'company-b', plan: 'PRO', niche: null },
    ],
    companies: [
      { id: 'company-a', name: 'Empresa A', userId: 'user-a', timezone: 'America/Sao_Paulo', createdAt: new Date() },
      { id: 'company-b', name: 'Empresa B', userId: 'user-b', timezone: 'America/Sao_Paulo', createdAt: new Date() },
    ],
    profiles: [] as any[],
    preferences: [] as Preference[],
    modulePreferences: [] as any[],
    agentConfigs: [] as any[],
    sales: [] as any[],
    transactions: [] as any[],
    costs: [] as any[],
    adSpends: [] as any[],
    customers: [] as any[],
    products: [] as any[],
    importedMetrics: [] as any[],
  };

  const inRange = (value: Date, range?: { gte?: Date; lte?: Date }) =>
    !range || ((!range.gte || value >= range.gte) && (!range.lte || value <= range.lte));
  const byCompanyRange = (items: any[], where: any, field: string) =>
    items.filter((item) => item.companyId === where.companyId && inRange(item[field], where[field]));

  return {
    state,
    prisma: {
      $transaction: async (operations: Promise<unknown>[]) => Promise.all(operations),
      user: {
        findUnique: async ({ where }: any) => state.users.find((user) => user.id === where.id) || null,
        updateMany: async () => ({ count: 1 }),
      },
      company: {
        count: async ({ where }: any = {}) => {
          if (!where?.OR) return state.companies.length;
          return state.companies.filter((company) =>
            where.OR.some((item: any) => item.userId === company.userId || item.users?.some?.id === company.userId),
          ).length;
        },
        findUnique: async ({ where }: any) => state.companies.find((company) => company.id === where.id) || null,
        findFirst: async ({ where }: any) => {
          const company = state.companies.find((item) => item.id === where.id);
          if (!company) return null;
          if (!where.OR) return company;
          return where.OR.some((item: any) => item.userId === company.userId || item.users?.some?.id === company.userId)
            ? company
            : null;
        },
      },
      companyProfile: {
        findUnique: async ({ where }: any) => state.profiles.find((profile) => profile.companyId === where.companyId) || null,
        upsert: async ({ where, update, create }: any) => {
          const index = state.profiles.findIndex((profile) => profile.companyId === where.companyId);
          if (index >= 0) {
            state.profiles[index] = { ...state.profiles[index], ...update };
            return state.profiles[index];
          }
          state.profiles.push(create);
          return create;
        },
      },
      dashboardPreference: {
        findMany: async ({ where }: any) =>
          state.preferences.filter((preference) => preference.companyId === where.companyId && preference.userId === (where.userId ?? null)),
        deleteMany: async ({ where }: any) => {
          const before = state.preferences.length;
          state.preferences = state.preferences.filter(
            (preference) => !(preference.companyId === where.companyId && preference.userId === (where.userId ?? null)),
          );
          return { count: before - state.preferences.length };
        },
        createMany: async ({ data }: any) => {
          state.preferences.push(...data);
          return { count: data.length };
        },
      },
      companyModulePreference: {
        findMany: async ({ where }: any) => state.modulePreferences.filter((item) => item.companyId === where.companyId),
        deleteMany: async ({ where }: any) => {
          state.modulePreferences = state.modulePreferences.filter((item) => item.companyId !== where.companyId);
          return { count: 1 };
        },
        createMany: async ({ data }: any) => {
          state.modulePreferences.push(...data);
          return { count: data.length };
        },
      },
      agentConfig: {
        findUnique: async ({ where }: any) => state.agentConfigs.find((item) => item.companyId === where.companyId) || null,
        upsert: async ({ where, create, update }: any) => {
          const index = state.agentConfigs.findIndex((item) => item.companyId === where.companyId);
          if (index >= 0) {
            state.agentConfigs[index] = { ...state.agentConfigs[index], ...update };
            return state.agentConfigs[index];
          }
          const saved = { id: `agent-${create.companyId}`, ...create };
          state.agentConfigs.push(saved);
          return saved;
        },
      },
      sale: {
        findMany: async ({ where }: any) => byCompanyRange(state.sales, where, 'occurredAt'),
        count: async ({ where }: any) => state.sales.filter((item) => item.companyId === where.companyId).length,
      },
      financialTransaction: {
        findMany: async ({ where }: any) => byCompanyRange(state.transactions, where, 'occurredAt'),
        count: async ({ where }: any) => state.transactions.filter((item) => item.companyId === where.companyId).length,
      },
      operationalCost: {
        findMany: async ({ where }: any) => byCompanyRange(state.costs, where, 'date'),
        count: async ({ where }: any) => state.costs.filter((item) => item.companyId === where.companyId).length,
      },
      adSpend: {
        findMany: async ({ where }: any) => byCompanyRange(state.adSpends, where, 'spentAt'),
      },
      customer: {
        count: async ({ where }: any) =>
          state.customers.filter((item) => item.companyId === where.companyId && inRange(item.createdAt, where.createdAt)).length,
      },
      product: {
        findMany: async ({ where }: any) => state.products.filter((item) => item.companyId === where.companyId),
        count: async ({ where }: any) => state.products.filter((item) => item.companyId === where.companyId).length,
      },
      importedMetric: {
        findMany: async ({ where }: any) =>
          state.importedMetrics.filter((item) => item.companyId === where.companyId),
      },
      whatsappConnection: { count: async () => 0 },
    },
  };
}

async function main() {
  assertSameArray(core, expectedCore, 'Core dashboard diferente do layout exigido');
  assert(
    DASHBOARD_METRICS.filter((metric) => metric.defaultEnabled).every((metric) => coreSet.has(metric.key)),
    'Existe metrica fora do core ligada por padrao',
  );
  ['cac', 'roas', 'ltv', 'churn', 'conversion_rate', 'best_selling_products', 'profit_by_product', 'refund_rate', 'shipping_costs', 'mrr', 'retention', 'activation_rate'].forEach((key) => {
    assert(!DASHBOARD_METRICS.find((metric) => metric.key === key)?.defaultEnabled, `${key} deve iniciar desligada`);
  });

  const fake = createFakePrisma();
  const dashboard = new DashboardService(fake.prisma as any);
  const personalization = new CompanyPersonalizationService(fake.prisma as any);

  const prefs = await dashboard.getPreferences('user-a', undefined, 'company-a');
  assertSameArray(prefs.resolvedLayout.map((item) => item.metricKey), expectedCore, 'A. Empresa nova nao recebeu apenas o core');

  const onboarding = await personalization.saveOnboarding(
    { sub: 'user-a', companyId: 'company-a', admin: false } as any,
    {
      businessType: 'saas',
      usesPaidTraffic: true,
      hasServices: true,
      hasOperationalCosts: true,
      applyRecommendedSetup: true,
    } as any,
  );
  const enabledAfterOnboarding = onboarding.dashboardPreferences.filter((item: any) => item.enabled).map((item: any) => item.metricKey);
  assertSameArray(enabledAfterOnboarding, expectedCore, 'B. Onboarding SaaS inundou o dashboard');
  const afterOnboardingPrefs = await dashboard.getPreferences('user-a', undefined, 'company-a');
  ['cac', 'roas', 'ltv', 'churn'].forEach((key) => {
    const pref = afterOnboardingPrefs.preferences.find((item) => item.metricKey === key);
    const metric = afterOnboardingPrefs.availableMetrics.find((item) => item.key === key);
    assert(pref?.enabled === false, `C. ${key} deveria estar disponivel e desligada`);
    if (key === 'cac' || key === 'roas') {
      assert(metric?.recommended === true, `C. ${key} deveria estar marcada como recomendada`);
    }
  });

  await dashboard.savePreferences('user-a', [{ metricKey: 'cac', enabled: true, order: 0 }], undefined, 'company-a');
  const resetPrefs = await dashboard.resetPreferences('user-a', undefined, 'company-a');
  assertSameArray(resetPrefs.resolvedLayout.map((item) => item.metricKey), expectedCore, 'D. Reset nao voltou ao core');

  const emptyMetrics = await dashboard.getMetrics('user-a', undefined, 'today', undefined, false, undefined, undefined, 'company-a');
  assert(emptyMetrics.metrics.revenue.value === 0 && emptyMetrics.metrics.revenue.status === 'ok' && emptyMetrics.metrics.revenue.formatted.includes('0,00'), 'E. Faturamento sem dados deve ser R$ 0,00');
  assert(emptyMetrics.metrics.losses.value === 0 && emptyMetrics.metrics.losses.status === 'ok' && emptyMetrics.metrics.losses.formatted.includes('0,00'), 'F. Perdas sem dados deve ser R$ 0,00');
  assert(emptyMetrics.metrics.net_profit.value === 0 && emptyMetrics.metrics.net_profit.status === 'ok' && emptyMetrics.metrics.net_profit.formatted.includes('0,00'), 'G. Lucro liquido sem dados deve ser R$ 0,00');
  assert(emptyMetrics.metrics.cash_flow.value === 0 && emptyMetrics.metrics.cash_flow.status === 'ok' && emptyMetrics.metrics.cash_flow.formatted.includes('0,00'), 'H. Fluxo de caixa sem dados deve ser R$ 0,00');

  await dashboard.savePreferences(
    'user-a',
    ['cac', 'roas', 'roi', 'ltv', 'churn', 'conversion_rate'].map((metricKey, order) => ({ metricKey, enabled: true, order })),
    undefined,
    'company-a',
  );
  const derived = await dashboard.getMetrics('user-a', undefined, 'today', 'cac,roas,roi,ltv,churn,conversion_rate', false, undefined, undefined, 'company-a');
  assert(derived.metrics.cac.formatted === 'Dado insuficiente', 'I. CAC deve mostrar Dado insuficiente');
  assert(derived.metrics.roas.formatted === 'Dado insuficiente', 'J. ROAS deve mostrar Dado insuficiente');
  assert(derived.metrics.roi.formatted === 'Dado insuficiente', 'ROI deve mostrar Dado insuficiente');
  assert(derived.metrics.ltv.formatted === 'Dado insuficiente', 'LTV deve mostrar Dado insuficiente');
  assert(derived.metrics.churn.formatted === 'Dado insuficiente', 'Churn deve mostrar Dado insuficiente');
  assert(derived.metrics.conversion_rate.formatted === 'Dado insuficiente', 'Conversao deve mostrar Dado insuficiente');

  await dashboard.resetPreferences('user-a', undefined, 'company-a');
  fake.state.sales.push({ companyId: 'company-a', amount: 100, productName: 'Plano', category: 'SaaS', occurredAt: daysAgo(1, 10) });
  fake.state.sales.push({ companyId: 'company-b', amount: 9999, productName: 'Outro', category: 'SaaS', occurredAt: todayAt(10) });
  const today = await dashboard.getMetrics('user-a', undefined, 'today', 'revenue', false, undefined, undefined, 'company-a');
  const week = await dashboard.getMetrics('user-a', undefined, '7d', 'revenue', false, undefined, undefined, 'company-a');
  assert(today.metrics.revenue.value === 0 && week.metrics.revenue.value === 100, 'K. Filtros de periodo nao alteraram valores');

  let blocked = false;
  try {
    await dashboard.getMetrics('user-a', 'company-b', 'today', 'revenue', false, undefined, undefined, 'company-a', false);
  } catch {
    blocked = true;
  }
  assert(blocked, 'L. Empresa A conseguiu acessar dados da Empresa B');

  console.log('Dashboard layout checks A-L passed.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
