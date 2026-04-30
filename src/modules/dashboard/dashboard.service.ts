import { BadRequestException, Injectable } from '@nestjs/common';
import { FinancialTransactionType, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { toZonedTime, fromZonedTime } from 'date-fns-tz';
import {
  DASHBOARD_METRIC_KEYS,
  DASHBOARD_METRICS,
  DashboardMetricDefinition,
  getDashboardDefaultOrder,
  getMetricDefinition,
} from './dashboard-metrics.registry';
import { buildPersonalizationRecommendations } from '../company-personalization/business-personalization.registry';

type DashboardPeriod = 'today' | 'yesterday' | 'week' | 'month' | 'year';
type DashboardMetricsPeriod = 'today' | 'yesterday' | '7d' | '30d' | 'month' | 'custom' | 'week' | 'year';
type DashboardMetricStatus = 'ok' | 'no_data' | 'not_enough_data';
type DashboardMetricDirection = 'up' | 'down' | 'flat';
type DashboardMetricClassification =
  | 'direct_money_total'
  | 'derived_ratio'
  | 'predictive'
  | 'attribution_required'
  | 'operational_count';

const METRIC_CLASSIFICATION: Record<string, DashboardMetricClassification> = {
  revenue: 'direct_money_total',
  income_revenue: 'direct_money_total',
  entries: 'direct_money_total',
  expenses: 'direct_money_total',
  outflows: 'direct_money_total',
  losses: 'direct_money_total',
  profit: 'direct_money_total',
  net_profit: 'direct_money_total',
  cash_flow: 'direct_money_total',
  operational_costs: 'direct_money_total',
  average_ticket: 'derived_ratio',
  margin: 'derived_ratio',
  waste_inefficiency: 'derived_ratio',
  conversion_rate: 'derived_ratio',
  cac: 'attribution_required',
  roi: 'attribution_required',
  roas: 'attribution_required',
  ltv: 'attribution_required',
  revenue_forecast: 'predictive',
  sales_count: 'operational_count',
  customers_acquired: 'operational_count',
  company_count: 'operational_count',
};

type TimelinePoint = {
  name: string;
  Receitas: number;
  Saidas: number;
};

type PiePoint = {
  name: string;
  value: number;
};

export interface DashboardSummaryDto {
  revenue: number;
  losses: number;
  profit: number;
  cashflow: number;
  companyCount: number;
  lineData: TimelinePoint[];
  pieData: PiePoint[];
  period: DashboardPeriod;
  enabledMetrics?: string[];
}

export interface DashboardFinancialDto {
  totalIncome: number;
  totalExpense: number;
  balance: number;
  transactionsCount: number;
}

export type DashboardPreferenceInput = {
  metricKey?: string;
  enabled?: boolean;
  order?: number;
  size?: string | null;
};

export type DashboardResolvedPreference = {
  metricKey: string;
  enabled: boolean;
  order: number;
  size: string | null;
};

export type DashboardResolvedLayoutItem = DashboardMetricDefinition & {
  metricKey: string;
  enabled: boolean;
  order: number;
  size: string | null;
};

export type DashboardPreferencesResponse = {
  availableMetrics: DashboardMetricDefinition[];
  preferences: DashboardResolvedPreference[];
  resolvedLayout: DashboardResolvedLayoutItem[];
};

export type DashboardMetricResult = {
  key: string;
  label: string;
  value: number | null;
  formatted: string;
  status: DashboardMetricStatus;
  reason?: string;
  sourceLabel?: string;
  comparison?: {
    previousValue: number;
    changePercent: number;
    direction: DashboardMetricDirection;
  };
};

export type DashboardChartPoint = Record<string, string | number | null>;

export type DashboardMetricsResponse = {
  period: {
    key: DashboardMetricsPeriod;
    startDate: string;
    endDate: string;
    label: string;
  };
  metrics: Record<string, DashboardMetricResult>;
  charts: {
    revenueByDay: DashboardChartPoint[];
    salesByProduct: DashboardChartPoint[];
    costsByCategory: DashboardChartPoint[];
    peakSalesHours: DashboardChartPoint[];
  };
  warnings: string[];
};

@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async getDashboard(companyId: string): Promise<DashboardFinancialDto> {
    if (!companyId?.trim()) {
      return this.zeroFinancialSummary();
    }

    const companyExists = await this.prisma.company.count({
      where: { id: companyId },
    });
    if (companyExists === 0) {
      return this.zeroFinancialSummary();
    }

    const transactions = await this.prisma.financialTransaction.findMany({
      where: { companyId },
      select: { type: true, amount: true },
    });

    const reduced = transactions.reduce(
      (acc, transaction) => {
        const amount = this.toNumber(transaction.amount);
        if (transaction.type === FinancialTransactionType.INCOME) {
          acc.totalIncome += amount;
        } else if (transaction.type === FinancialTransactionType.EXPENSE) {
          acc.totalExpense += amount;
        }
        acc.transactionsCount += 1;
        return acc;
      },
      { totalIncome: 0, totalExpense: 0, transactionsCount: 0 },
    );

    const balance = reduced.totalIncome - reduced.totalExpense;

    return {
      totalIncome: this.round(reduced.totalIncome),
      totalExpense: this.round(reduced.totalExpense),
      balance: this.round(balance),
      transactionsCount: reduced.transactionsCount,
    };
  }

  async getSummary(
    userId: string,
    requestedCompanyId?: string,
    rawPeriod?: string,
    rawMetrics?: string,
  ): Promise<DashboardSummaryDto> {
    const period = this.normalizePeriod(rawPeriod);
    const [user, companyCount] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        select: { companyId: true },
      }),
      this.prisma.company.count({
        where: {
          OR: [{ userId }, { users: { some: { id: userId } } }],
        },
      }),
    ]);

    const companyId = await this.resolveCompanyId(
      userId,
      requestedCompanyId,
      user?.companyId,
    );
    if (!companyId) {
      return this.zeroSummary(companyCount, period);
    }

    const enabledMetrics = await this.resolveEnabledMetricKeys(companyId, rawMetrics);

    const companyData = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { timezone: true },
    });
    const timeZone = companyData?.timezone || 'America/Sao_Paulo';

    const { start, end } = this.resolvePeriodRange(period, timeZone);
    const [sales, transactions, adSpends] = await Promise.all([
      this.prisma.sale.findMany({
        where: {
          companyId,
          occurredAt: { gte: start, lte: end },
        },
        select: {
          amount: true,
          category: true,
          productName: true,
          occurredAt: true,
        },
        orderBy: { occurredAt: 'asc' },
      }),
      this.prisma.financialTransaction.findMany({
        where: {
          companyId,
          occurredAt: { gte: start, lte: end },
        },
        select: {
          amount: true,
          type: true,
          category: true,
          description: true,
          occurredAt: true,
        },
        orderBy: { occurredAt: 'asc' },
      }),
      this.prisma.adSpend.findMany({
        where: {
          companyId,
          spentAt: { gte: start, lte: end },
        },
        select: {
          amount: true,
          source: true,
          spentAt: true,
        },
        orderBy: { spentAt: 'asc' },
      }),
    ]);

    const revenue =
      sales.reduce((total, sale) => total + this.toNumber(sale.amount), 0) +
      transactions
        .filter((item) => item.type === FinancialTransactionType.INCOME)
        .reduce((total, item) => total + this.toNumber(item.amount), 0);

    const losses =
      transactions
        .filter((item) => item.type === FinancialTransactionType.EXPENSE)
        .reduce((total, item) => total + this.toNumber(item.amount), 0) +
      adSpends.reduce((total, item) => total + this.toNumber(item.amount), 0);

    const profit = revenue - losses;
    const lineData = this.buildTimeline(period, start, end, sales, transactions, adSpends, timeZone);
    const pieData = this.buildPieData(sales, transactions, adSpends);

    return {
      revenue: this.round(revenue),
      losses: this.round(losses),
      profit: this.round(profit),
      cashflow: this.round(profit),
      companyCount,
      lineData,
      pieData,
      period,
      enabledMetrics,
    };
  }

  async getMetrics(
    userId: string,
    requestedCompanyId?: string,
    rawPeriod?: string,
    rawMetrics?: string,
    comparePrevious = true,
    startDate?: string,
    endDate?: string,
    fallbackCompanyId?: string | null,
    isAdmin = false,
  ): Promise<DashboardMetricsResponse> {
    const [user, companyCount] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        select: { companyId: true },
      }),
      this.prisma.company.count({
        where: {
          OR: [{ userId }, { users: { some: { id: userId } } }],
        },
      }),
    ]);

    const companyId = await this.resolveCompanyId(
      userId,
      requestedCompanyId,
      fallbackCompanyId ?? user?.companyId,
      isAdmin,
    );
    if (!companyId) {
      throw new BadRequestException('companyId nao informado');
    }

    const companyData = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { timezone: true },
    });
    const timeZone = companyData?.timezone || 'America/Sao_Paulo';
    const period = this.resolveMetricsPeriod(rawPeriod, timeZone, startDate, endDate);
    const enabledMetrics = await this.resolveEnabledMetricKeys(companyId, rawMetrics);
    const enabledMetricSet = new Set(enabledMetrics);
    const warnings: string[] = [];

    const [currentData, previousData, productCatalog] = await Promise.all([
      this.loadMetricSourceData(companyId, period.start, period.end),
      comparePrevious
        ? this.loadMetricSourceData(companyId, period.previousStart, period.previousEnd)
        : Promise.resolve(null),
      this.prisma.product.findMany({
        where: { companyId },
        select: { name: true, cost: true, tax: true, shipping: true },
      }),
    ]);

    const currentTotals = this.calculateMetricTotals(currentData, productCatalog);
    const previousTotals = previousData
      ? this.calculateMetricTotals(previousData, productCatalog)
      : null;

    const metrics: Record<string, DashboardMetricResult> = {};
    const addMetric = (metricKey: string, result: DashboardMetricResult) => {
      if (enabledMetricSet.has(metricKey)) {
        metrics[metricKey] = result;
      }
    };

    addMetric(
      'revenue',
      this.numberMetric('revenue', currentTotals.revenue, previousTotals?.revenue, {
        kind: 'currency',
        sourceLabel: currentTotals.sourceLabels?.revenue,
      }),
    );
    addMetric(
      'income_revenue',
      this.numberMetric('income_revenue', currentTotals.revenue, previousTotals?.revenue, {
        kind: 'currency',
        sourceLabel: currentTotals.sourceLabels?.revenue,
      }),
    );
    addMetric(
      'entries',
      this.numberMetric('entries', currentTotals.transactionIncome, previousTotals?.transactionIncome, {
        kind: 'currency',
      }),
    );
    addMetric(
      'expenses',
      this.numberMetric('expenses', currentTotals.transactionExpenses, previousTotals?.transactionExpenses, {
        kind: 'currency',
      }),
    );
    addMetric(
      'outflows',
      this.numberMetric('outflows', currentTotals.totalOutflows, previousTotals?.totalOutflows, {
        kind: 'currency',
      }),
    );
    addMetric(
      'sales_count',
      this.numberMetric('sales_count', currentTotals.salesCount, previousTotals?.salesCount, {
        noData: currentTotals.salesCount === 0,
        kind: 'integer',
      }),
    );
    addMetric(
      'average_ticket',
      currentTotals.salesCount > 0
        ? this.numberMetric('average_ticket', currentTotals.revenue / currentTotals.salesCount, previousTotals && previousTotals.salesCount > 0 ? previousTotals.revenue / previousTotals.salesCount : undefined, { kind: 'currency' })
        : this.noDataMetric('average_ticket', 'Nenhuma venda registrada no periodo.'),
    );
    addMetric(
      'losses',
      this.numberMetric('losses', currentTotals.totalOutflows, previousTotals?.totalOutflows, {
        kind: 'currency',
        sourceLabel: currentTotals.sourceLabels?.losses,
      }),
    );
    addMetric(
      'operational_costs',
      this.numberMetric('operational_costs', currentTotals.operationalCosts, previousTotals?.operationalCosts, {
        kind: 'currency',
        sourceLabel: currentTotals.sourceLabels?.operationalCosts,
      }),
    );
    addMetric(
      'cash_flow',
      this.numberMetric('cash_flow', currentTotals.cashFlow, previousTotals?.cashFlow, {
        kind: 'currency',
        sourceLabel: currentTotals.sourceLabels?.cashFlow,
      }),
    );
    addMetric(
      'profit',
      this.numberMetric('profit', currentTotals.netProfit, previousTotals?.netProfit, {
        kind: 'currency',
        sourceLabel: currentTotals.sourceLabels?.netProfit,
      }),
    );
    addMetric(
      'net_profit',
      this.numberMetric('net_profit', currentTotals.netProfit, previousTotals?.netProfit, {
        kind: 'currency',
        sourceLabel: currentTotals.sourceLabels?.netProfit,
      }),
    );
    addMetric(
      'margin',
      currentTotals.revenue > 0
        ? this.numberMetric('margin', (currentTotals.netProfit / currentTotals.revenue) * 100, previousTotals && previousTotals.revenue > 0 ? (previousTotals.netProfit / previousTotals.revenue) * 100 : undefined, { kind: 'percent' })
        : this.noDataMetric('margin', 'Receita igual a zero no periodo.'),
    );
    addMetric(
      'waste_inefficiency',
      currentTotals.revenue > 0
        ? this.numberMetric('waste_inefficiency', (currentTotals.operationalCosts / currentTotals.revenue) * 100, previousTotals && previousTotals.revenue > 0 ? (previousTotals.operationalCosts / previousTotals.revenue) * 100 : undefined, { kind: 'percent' })
        : this.noDataMetric('waste_inefficiency', 'Receita igual a zero no periodo.'),
    );
    addMetric(
      'customers_acquired',
      this.numberMetric('customers_acquired', currentData.newCustomersCount, previousData?.newCustomersCount, {
        noData: currentData.newCustomersCount === 0,
        kind: 'integer',
      }),
    );
    addMetric(
      'company_count',
      this.numberMetric('company_count', companyCount, undefined, { kind: 'integer' }),
    );
    addMetric(
      'best_selling_products',
      currentData.sales.length > 0
        ? this.numberMetric('best_selling_products', currentData.sales.length, previousData?.sales.length, { kind: 'integer' })
        : this.noDataMetric('best_selling_products', 'Nenhuma venda com produto registrada no periodo.'),
    );
    addMetric(
      'peak_sales_hours',
      currentData.sales.length > 0
        ? this.numberMetric('peak_sales_hours', currentData.sales.length, previousData?.sales.length, { kind: 'integer' })
        : this.noDataMetric('peak_sales_hours', 'Nenhuma venda registrada no periodo.'),
    );

    const unsupportedMetrics: Record<string, string> = {
      conversion_rate: 'Missing visitors/leads-to-sales conversion tracking.',
      cac: 'Missing reliable paid media acquisition attribution by customer.',
      roi: 'Missing explicit investment cost model. ROI is not ROAS.',
      roas: 'Missing ad-attributed revenue. Total revenue is not used as ROAS.',
      ltv: 'Missing customer-to-sale purchase history relation.',
      repeat_customers: 'Missing customer-to-sale purchase history relation.',
      profit_by_product: 'Missing sale item quantity/product relation for accurate product profit.',
      market_opportunities: 'Market opportunities are produced by market intelligence endpoints, not enough dashboard data in this response.',
      ai_roi: 'AI attribution is available from /api/attendant/roi and is kept separate from financial dashboard calculations.',
      revenue_forecast: 'Forecast is available from /api/analytics/forecast/REVENUE and is kept separate from historical metrics.',
      alerts_insights: 'Insights are generated by the AI insight flow and are kept separate from historical metric calculations.',
      refund_rate: 'Missing refund/order status data.',
      funnel_conversion: 'Missing funnel event tracking.',
      mrr: 'Missing subscription/billing model for recurring revenue.',
      churn: 'Missing subscription cancellation history.',
      activation_rate: 'Missing product activation event tracking.',
      retention: 'Missing cohort/customer activity tracking.',
      active_customers: 'Missing active usage or subscription state tracking.',
      plan_conversion: 'Missing trial-to-plan conversion tracking.',
      client_revenue: 'Missing customer-to-sale attribution for revenue by client.',
      profit_margin: 'Use margin when enough sales and cost data exists; segment-specific profit margin requires customer/project attribution.',
      customer_retention: 'Missing customer purchase/renewal history.',
      lead_conversion: 'Missing reliable lead-to-sale conversion relation.',
      appointments: 'Missing appointment scheduling model.',
      no_show_rate: 'Missing appointment status/no-show model.',
      service_revenue: 'Missing service-specific sale classification.',
      new_patients: 'Missing patient-specific profile model; generic customers_acquired is available.',
      returning_patients: 'Missing appointment/customer recurrence model.',
      leads: 'Missing lead-source aggregation in dashboard metrics.',
      consultations: 'Missing consultation/appointment model.',
      case_pipeline: 'Missing legal pipeline/case model.',
      client_followup: 'Missing task/follow-up model.',
      bookings: 'Missing booking/scheduling model.',
      stock_movement: 'Missing inventory movement model.',
      peak_hours: 'Use peak_sales_hours when sales timestamps exist; restaurant-specific peak hours need order source classification.',
      best_selling_items: 'Use best_selling_products when sale product names exist; menu item model is not available.',
      delivery_costs: 'Missing delivery cost classification.',
      marketplace_fees: 'Missing marketplace order fee model.',
      shipping_costs: 'Missing shipping cost model.',
    };

    Object.entries(unsupportedMetrics).forEach(([metricKey, reason]) => {
      if (enabledMetricSet.has(metricKey)) {
        metrics[metricKey] = this.notEnoughDataMetric(metricKey, reason);
        warnings.push(`${metricKey}: ${reason}`);
      }
    });

    const charts = {
      revenueByDay: enabledMetricSet.has('cash_flow_summary')
        ? this.buildRevenueByDay(period.start, period.end, currentData, timeZone)
        : [],
      salesByProduct: enabledMetricSet.has('best_selling_products') || enabledMetricSet.has('category_mix')
        ? this.buildSalesByProduct(currentData.sales)
        : [],
      costsByCategory: enabledMetricSet.has('category_mix') || enabledMetricSet.has('operational_costs')
        ? this.buildCostsByCategory(currentData.operationalCosts, currentData.transactions, currentData.adSpends)
        : [],
      peakSalesHours: enabledMetricSet.has('peak_sales_hours')
        ? this.buildPeakSalesHours(currentData.sales, timeZone)
        : [],
    };

    return {
      period: {
        key: period.key,
        startDate: period.start.toISOString(),
        endDate: period.end.toISOString(),
        label: period.label,
      },
      metrics,
      charts,
      warnings,
    };
  }

  async getPreferences(
    userId: string,
    requestedCompanyId?: string,
    fallbackCompanyId?: string | null,
    isAdmin = false,
  ): Promise<DashboardPreferencesResponse> {
    const companyId = await this.resolveCompanyId(
      userId,
      requestedCompanyId,
      fallbackCompanyId,
      isAdmin,
    );
    if (!companyId) {
      throw new BadRequestException('companyId nao informado');
    }

    return this.buildPreferencesResponse(companyId);
  }

  async savePreferences(
    userId: string,
    payload: DashboardPreferenceInput[],
    requestedCompanyId?: string,
    fallbackCompanyId?: string | null,
    isAdmin = false,
  ): Promise<DashboardPreferencesResponse> {
    const companyId = await this.resolveCompanyId(
      userId,
      requestedCompanyId,
      fallbackCompanyId,
      isAdmin,
    );
    if (!companyId) {
      throw new BadRequestException('companyId nao informado');
    }
    if (!Array.isArray(payload)) {
      throw new BadRequestException('preferences deve ser uma lista');
    }

    const overrides = new Map<string, DashboardResolvedPreference>();
    payload.forEach((item, index) => {
      const metricKey = String(item?.metricKey || '').trim();
      if (!DASHBOARD_METRIC_KEYS.has(metricKey)) {
        throw new BadRequestException(`Metrica desconhecida: ${metricKey || '(vazia)'}`);
      }
      overrides.set(metricKey, {
        metricKey,
        enabled: Boolean(item.enabled),
        order: Number.isFinite(Number(item.order)) ? Number(item.order) : index,
        size: this.normalizeSize(item.size),
      });
    });

    const preferences = DASHBOARD_METRICS.map((metric, index) => {
      const override = overrides.get(metric.key);
      return {
        metricKey: metric.key,
        enabled: override?.enabled ?? metric.defaultEnabled,
        order: override?.order ?? getDashboardDefaultOrder(metric.key, index),
        size: override?.size ?? null,
      };
    });

    await this.prisma.$transaction([
      this.prisma.dashboardPreference.deleteMany({
        where: { companyId, userId: null },
      }),
      this.prisma.dashboardPreference.createMany({
        data: preferences.map((preference) => ({
          companyId,
          userId: null,
          metricKey: preference.metricKey,
          enabled: preference.enabled,
          order: preference.order,
          size: preference.size,
        })),
      }),
    ]);

    return this.buildPreferencesResponse(companyId);
  }

  async resetPreferences(
    userId: string,
    requestedCompanyId?: string,
    fallbackCompanyId?: string | null,
    isAdmin = false,
  ): Promise<DashboardPreferencesResponse> {
    const companyId = await this.resolveCompanyId(
      userId,
      requestedCompanyId,
      fallbackCompanyId,
      isAdmin,
    );
    if (!companyId) {
      throw new BadRequestException('companyId nao informado');
    }

    await this.prisma.dashboardPreference.deleteMany({
      where: { companyId, userId: null },
    });

    return this.buildPreferencesResponse(companyId);
  }

  private async resolveCompanyId(
    userId: string,
    requestedCompanyId?: string,
    fallbackCompanyId?: string | null,
    isAdmin = false,
  ): Promise<string | null> {
    if (requestedCompanyId?.trim()) {
      const company = await this.prisma.company.findFirst({
        where: {
          id: requestedCompanyId.trim(),
          ...(isAdmin
            ? {}
            : { OR: [{ userId }, { users: { some: { id: userId } } }] }),
        },
        select: { id: true },
      });

      if (!company) {
        throw new BadRequestException('Empresa invalida');
      }

      return company.id;
    }

    return fallbackCompanyId || null;
  }

  private async buildPreferencesResponse(companyId: string): Promise<DashboardPreferencesResponse> {
    const [persisted, profile, company] = await Promise.all([
      this.prisma.dashboardPreference.findMany({
        where: { companyId, userId: null },
        select: {
          metricKey: true,
          enabled: true,
          order: true,
          size: true,
        },
      }),
      this.prisma.companyProfile.findUnique({
        where: { companyId },
      }),
      this.prisma.company.findUnique({
        where: { id: companyId },
        select: { name: true },
      }),
    ]);
    const byMetric = new Map(persisted.map((item) => [item.metricKey, item]));
    const recommendedMetricKeys = new Set(
      profile
        ? buildPersonalizationRecommendations(profile, company?.name).dashboardMetrics.filter((metricKey) =>
            DASHBOARD_METRIC_KEYS.has(metricKey),
          )
        : [],
    );
    const availableMetrics = DASHBOARD_METRICS.map((metric) => ({
      ...metric,
      recommended: recommendedMetricKeys.has(metric.key),
    }));
    const preferences = DASHBOARD_METRICS.map((metric, index) => {
      const saved = byMetric.get(metric.key);
      return {
        metricKey: metric.key,
        enabled: saved?.enabled ?? metric.defaultEnabled,
        order: saved?.order ?? getDashboardDefaultOrder(metric.key, index),
        size: saved?.size ?? null,
      };
    }).sort((a, b) => a.order - b.order);

    const definitionsByKey = new Map(availableMetrics.map((metric) => [metric.key, metric]));
    const resolvedLayout: DashboardResolvedLayoutItem[] = preferences
      .filter((preference) => preference.enabled)
      .reduce<DashboardResolvedLayoutItem[]>((items, preference) => {
        const metric = definitionsByKey.get(preference.metricKey);
        if (!metric) return items;
        items.push({
          ...metric,
          metricKey: preference.metricKey,
          enabled: preference.enabled,
          order: preference.order,
          size: preference.size,
        });
        return items;
      }, []);

    return {
      availableMetrics,
      preferences,
      resolvedLayout,
    };
  }

  private async resolveEnabledMetricKeys(companyId: string, rawMetrics?: string): Promise<string[]> {
    const preferences = await this.buildPreferencesResponse(companyId);
    const allowed = new Set(preferences.resolvedLayout.map((item) => item.metricKey));
    const requested = String(rawMetrics || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);

    if (requested.length === 0) {
      return Array.from(allowed);
    }

    for (const metricKey of requested) {
      if (!DASHBOARD_METRIC_KEYS.has(metricKey)) {
        throw new BadRequestException(`Metrica desconhecida: ${metricKey}`);
      }
      if (!allowed.has(metricKey)) {
        throw new BadRequestException(`Metrica desabilitada para esta empresa: ${metricKey}`);
      }
    }

    return requested;
  }

  private normalizeSize(size?: string | null): string | null {
    const normalized = String(size || '').trim().toLowerCase();
    if (['small', 'medium', 'large'].includes(normalized)) {
      return normalized;
    }
    return null;
  }

  private resolveMetricsPeriod(
    rawPeriod: string | undefined,
    timeZone: string,
    rawStartDate?: string,
    rawEndDate?: string,
  ) {
    const key = this.normalizeMetricsPeriod(rawPeriod);
    const nowUtc = new Date();
    const zonedNow = toZonedTime(nowUtc, timeZone);
    const endZoned = new Date(zonedNow);
    let startZoned = new Date(zonedNow);
    let label = 'Hoje';

    if (key === 'custom') {
      const parsedStart = rawStartDate ? new Date(`${rawStartDate}T00:00:00`) : null;
      const parsedEnd = rawEndDate ? new Date(`${rawEndDate}T23:59:59.999`) : null;
      if (!parsedStart || !parsedEnd || Number.isNaN(parsedStart.getTime()) || Number.isNaN(parsedEnd.getTime())) {
        throw new BadRequestException('startDate e endDate sao obrigatorios para periodo custom');
      }
      if (parsedStart > parsedEnd) {
        throw new BadRequestException('startDate deve ser anterior a endDate');
      }
      startZoned = parsedStart;
      endZoned.setTime(parsedEnd.getTime());
      label = 'Periodo personalizado';
    } else if (key === 'today') {
      startZoned.setHours(0, 0, 0, 0);
      endZoned.setHours(23, 59, 59, 999);
      label = 'Hoje';
    } else if (key === 'yesterday') {
      startZoned.setDate(startZoned.getDate() - 1);
      startZoned.setHours(0, 0, 0, 0);
      endZoned.setDate(endZoned.getDate() - 1);
      endZoned.setHours(23, 59, 59, 999);
      label = 'Ontem';
    } else if (key === 'month') {
      startZoned = new Date(zonedNow.getFullYear(), zonedNow.getMonth(), 1, 0, 0, 0, 0);
      endZoned.setHours(23, 59, 59, 999);
      label = 'Mes atual';
    } else if (key === 'year') {
      startZoned = new Date(zonedNow.getFullYear(), 0, 1, 0, 0, 0, 0);
      endZoned.setHours(23, 59, 59, 999);
      label = 'Ano atual';
    } else {
      const days = key === '30d' ? 30 : 7;
      startZoned.setDate(startZoned.getDate() - (days - 1));
      startZoned.setHours(0, 0, 0, 0);
      endZoned.setHours(23, 59, 59, 999);
      label = `Ultimos ${days} dias`;
    }

    const start = fromZonedTime(startZoned, timeZone);
    const end = fromZonedTime(endZoned, timeZone);
    const durationMs = Math.max(1, end.getTime() - start.getTime());
    const previousEnd = new Date(start.getTime() - 1);
    const previousStart = new Date(previousEnd.getTime() - durationMs);

    return { key, start, end, previousStart, previousEnd, label };
  }

  private normalizeMetricsPeriod(period?: string): DashboardMetricsPeriod {
    switch ((period || '').trim().toLowerCase()) {
      case 'yesterday':
        return 'yesterday';
      case '7d':
      case 'week':
        return '7d';
      case '30d':
        return '30d';
      case 'month':
        return 'month';
      case 'year':
        return 'year';
      case 'custom':
        return 'custom';
      default:
        return 'today';
    }
  }

  private async loadMetricSourceData(companyId: string, start: Date, end: Date) {
    const [sales, transactions, operationalCosts, adSpends, newCustomersCount, importedMetrics] = await Promise.all([
      this.prisma.sale.findMany({
        where: { companyId, occurredAt: { gte: start, lte: end } },
        select: { amount: true, productName: true, category: true, occurredAt: true },
        orderBy: { occurredAt: 'asc' },
      }),
      this.prisma.financialTransaction.findMany({
        where: { companyId, occurredAt: { gte: start, lte: end } },
        select: { amount: true, type: true, category: true, description: true, occurredAt: true },
        orderBy: { occurredAt: 'asc' },
      }),
      this.prisma.operationalCost.findMany({
        where: { companyId, date: { gte: start, lte: end } },
        select: { amount: true, category: true, name: true, date: true },
        orderBy: { date: 'asc' },
      }),
      this.prisma.adSpend.findMany({
        where: { companyId, spentAt: { gte: start, lte: end } },
        select: { amount: true, source: true, spentAt: true },
        orderBy: { spentAt: 'asc' },
      }),
      this.prisma.customer.count({
        where: { companyId, createdAt: { gte: start, lte: end } },
      }),
      this.prisma.importedMetric.findMany({
        where: {
          companyId,
          status: 'CONFIRMED',
          OR: [
            {
              periodStart: { lte: end },
              periodEnd: { gte: start },
            },
            {
              periodStart: null,
              periodEnd: null,
              createdAt: { gte: start, lte: end },
            },
          ],
        },
        select: {
          metricKey: true,
          value: true,
          source: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    return { sales, transactions, operationalCosts, adSpends, newCustomersCount, importedMetrics };
  }

  private calculateMetricTotals(
    data: Awaited<ReturnType<DashboardService['loadMetricSourceData']>>,
    products: Array<{ name: string; cost: Prisma.Decimal | null; tax: Prisma.Decimal | null; shipping: Prisma.Decimal | null }>,
  ) {
    const productCostByName = new Map<string, number>();
    products.forEach((product) => {
      const totalUnitCost =
        this.toNumber(product.cost) + this.toNumber(product.tax) + this.toNumber(product.shipping);
      productCostByName.set(product.name.trim().toLowerCase(), totalUnitCost);
    });

    const importedMetricNumber = (metricKeys: string[]) =>
      data.importedMetrics
        .filter((item) => metricKeys.includes(item.metricKey))
        .reduce((total, item) => total + this.jsonNumber(item.value), 0);

    const salesRevenue = data.sales.reduce((total, sale) => total + this.toNumber(sale.amount), 0);
    const transactionIncome = data.transactions
      .filter((item) => item.type === FinancialTransactionType.INCOME)
      .reduce((total, item) => total + this.toNumber(item.amount), 0);
    const transactionExpenses = data.transactions
      .filter((item) => item.type === FinancialTransactionType.EXPENSE)
      .reduce((total, item) => total + this.toNumber(item.amount), 0);
    const operationalCosts = data.operationalCosts.reduce((total, item) => total + this.toNumber(item.amount), 0);
    const adSpend = data.adSpends.reduce((total, item) => total + this.toNumber(item.amount), 0);
    const estimatedProductCosts = data.sales.reduce((total, sale) => {
      const productKey = (sale.productName || '').trim().toLowerCase();
      if (!productKey) return total;
      return total + (productCostByName.get(productKey) || 0);
    }, 0);
    const nativeRevenue = salesRevenue + transactionIncome;
    const importedRevenue = importedMetricNumber(['revenue', 'income_revenue', 'grossRevenue', 'netRevenue', 'revenueAttributed']);
    const revenue = nativeRevenue > 0 ? nativeRevenue : importedRevenue;
    const nativeOperationalCosts = operationalCosts;
    const fallbackOperationalCosts = importedMetricNumber(['operationalCosts']);
    const resolvedOperationalCosts =
      nativeOperationalCosts > 0 ? nativeOperationalCosts : fallbackOperationalCosts;
    const nativeTransactionExpenses = transactionExpenses;
    const fallbackTransactionExpenses = importedMetricNumber(['expenses']);
    const resolvedTransactionExpenses =
      nativeTransactionExpenses > 0 ? nativeTransactionExpenses : fallbackTransactionExpenses;
    const fallbackLosses = importedMetricNumber(['losses']);
    const nativeOutflows = resolvedTransactionExpenses + resolvedOperationalCosts + adSpend + estimatedProductCosts;
    const totalOutflows = nativeOutflows > 0 ? nativeOutflows : fallbackLosses;
    const fallbackNetProfit = importedMetricNumber(['netProfit', 'profit']);
    const fallbackCashFlow = importedMetricNumber(['cashFlow']);
    const salesCount =
      data.sales.length +
      data.transactions.filter((item) => item.type === FinancialTransactionType.INCOME).length;
    const fallbackSalesCount = importedMetricNumber(['orderCount']);
    const resolvedSalesCount = salesCount > 0 ? salesCount : Math.round(fallbackSalesCount);
    const netProfit = revenue - totalOutflows;
    const resolvedNetProfit =
      revenue > 0 || totalOutflows > 0 ? netProfit : fallbackNetProfit;
    const resolvedCashFlow =
      revenue > 0 || resolvedTransactionExpenses > 0 || resolvedOperationalCosts > 0 || adSpend > 0
        ? revenue - resolvedTransactionExpenses - resolvedOperationalCosts - adSpend
        : fallbackCashFlow;

    return {
      revenue: this.round(revenue),
      transactionIncome: this.round(transactionIncome),
      salesCount: resolvedSalesCount,
      revenueSources: data.sales.length + data.transactions.filter((item) => item.type === FinancialTransactionType.INCOME).length,
      operationalCosts: this.round(resolvedOperationalCosts),
      operationalCostCount: data.operationalCosts.length,
      adSpend: this.round(adSpend),
      transactionExpenses: this.round(resolvedTransactionExpenses),
      estimatedProductCosts: this.round(estimatedProductCosts),
      totalOutflows: this.round(totalOutflows),
      netProfit: this.round(resolvedNetProfit),
      cashFlow: this.round(resolvedCashFlow),
      cashFlowSources: data.sales.length + data.transactions.length + data.operationalCosts.length + data.adSpends.length,
      sourceLabels: {
        revenue: nativeRevenue > 0 ? undefined : importedRevenue > 0 ? 'Fonte: Importacao Inteligente' : undefined,
        losses:
          nativeOutflows > 0
            ? undefined
            : fallbackLosses > 0
              ? 'Fonte: Importacao Inteligente'
              : undefined,
        netProfit:
          revenue > 0 || totalOutflows > 0
            ? undefined
            : fallbackNetProfit > 0
              ? 'Fonte: Importacao Inteligente'
              : undefined,
        cashFlow:
          revenue > 0 || resolvedTransactionExpenses > 0 || resolvedOperationalCosts > 0 || adSpend > 0
            ? undefined
            : fallbackCashFlow > 0
              ? 'Fonte: Importacao Inteligente'
              : undefined,
        operationalCosts:
          nativeOperationalCosts > 0
            ? undefined
            : fallbackOperationalCosts > 0
              ? 'Fonte: Importacao Inteligente'
              : undefined,
      },
    };
  }

  private numberMetric(
    metricKey: string,
    value: number,
    previousValue?: number,
    options?: { noData?: boolean; kind?: 'currency' | 'percent' | 'integer' | 'number'; sourceLabel?: string },
  ): DashboardMetricResult {
    if (options?.noData) {
      if (METRIC_CLASSIFICATION[metricKey] === 'direct_money_total') {
        return this.zeroMoneyMetric(metricKey, previousValue);
      }
      return this.noDataMetric(metricKey, 'Nenhum dado encontrado no periodo.');
    }

    const roundedValue = options?.kind === 'integer' ? Math.round(value) : this.round(value);
    return {
      key: metricKey,
      label: this.metricLabel(metricKey),
      value: roundedValue,
      formatted: this.formatMetricValue(roundedValue, options?.kind || 'number'),
      status: 'ok',
      sourceLabel: options?.sourceLabel,
      comparison:
        previousValue === undefined
          ? undefined
          : this.buildComparison(roundedValue, previousValue),
    };
  }

  private noDataMetric(metricKey: string, reason: string): DashboardMetricResult {
    return {
      key: metricKey,
      label: this.metricLabel(metricKey),
      value: null,
      formatted: 'Sem dados',
      status: 'no_data',
      reason,
    };
  }

  private zeroMoneyMetric(metricKey: string, previousValue?: number): DashboardMetricResult {
    return {
      key: metricKey,
      label: this.metricLabel(metricKey),
      value: 0,
      formatted: this.formatMetricValue(0, 'currency'),
      status: 'ok',
      comparison:
        previousValue === undefined
          ? undefined
          : this.buildComparison(0, previousValue),
    };
  }

  private notEnoughDataMetric(metricKey: string, reason: string): DashboardMetricResult {
    return {
      key: metricKey,
      label: this.metricLabel(metricKey),
      value: null,
      formatted: 'Dado insuficiente',
      status: 'not_enough_data',
      reason,
    };
  }

  private metricLabel(metricKey: string): string {
    return getMetricDefinition(metricKey)?.label || metricKey;
  }

  private formatMetricValue(value: number, kind: 'currency' | 'percent' | 'integer' | 'number'): string {
    if (kind === 'currency') {
      return new Intl.NumberFormat('pt-BR', {
        style: 'currency',
        currency: 'BRL',
      }).format(value);
    }
    if (kind === 'percent') {
      return `${this.round(value).toLocaleString('pt-BR', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })}%`;
    }
    if (kind === 'integer') {
      return Math.round(value).toLocaleString('pt-BR');
    }
    return this.round(value).toLocaleString('pt-BR', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }

  private buildComparison(currentValue: number, previousValue: number) {
    const roundedPrevious = this.round(previousValue);
    if (roundedPrevious === 0) {
      return {
        previousValue: roundedPrevious,
        changePercent: currentValue === 0 ? 0 : 100,
        direction: currentValue === 0 ? ('flat' as const) : ('up' as const),
      };
    }

    const changePercent = this.round(((currentValue - roundedPrevious) / Math.abs(roundedPrevious)) * 100);
    return {
      previousValue: roundedPrevious,
      changePercent,
      direction: changePercent > 0 ? ('up' as const) : changePercent < 0 ? ('down' as const) : ('flat' as const),
    };
  }

  private buildRevenueByDay(
    start: Date,
    end: Date,
    data: Awaited<ReturnType<DashboardService['loadMetricSourceData']>>,
    timeZone: string,
  ): DashboardChartPoint[] {
    const labels = this.getDailyLabels(start, end, timeZone);
    const buckets = new Map(labels.map((label) => [label, { name: label, Receitas: 0, Saidas: 0 }]));

    data.sales.forEach((sale) => {
      const label = this.getDayLabel(toZonedTime(sale.occurredAt, timeZone));
      const bucket = buckets.get(label);
      if (bucket) bucket.Receitas += this.toNumber(sale.amount);
    });
    data.transactions.forEach((transaction) => {
      const label = this.getDayLabel(toZonedTime(transaction.occurredAt, timeZone));
      const bucket = buckets.get(label);
      if (!bucket) return;
      if (transaction.type === FinancialTransactionType.INCOME) {
        bucket.Receitas += this.toNumber(transaction.amount);
      } else {
        bucket.Saidas += this.toNumber(transaction.amount);
      }
    });
    data.operationalCosts.forEach((cost) => {
      const label = this.getDayLabel(toZonedTime(cost.date, timeZone));
      const bucket = buckets.get(label);
      if (bucket) bucket.Saidas += this.toNumber(cost.amount);
    });
    data.adSpends.forEach((spend) => {
      const label = this.getDayLabel(toZonedTime(spend.spentAt, timeZone));
      const bucket = buckets.get(label);
      if (bucket) bucket.Saidas += this.toNumber(spend.amount);
    });

    return Array.from(buckets.values()).map((item) => ({
      name: item.name,
      Receitas: this.round(item.Receitas),
      Saidas: this.round(item.Saidas),
    }));
  }

  private buildSalesByProduct(
    sales: Array<{ amount: Prisma.Decimal; productName: string | null; category: string | null }>,
  ): DashboardChartPoint[] {
    const totals = new Map<string, { revenue: number; count: number }>();
    sales.forEach((sale) => {
      const name = sale.productName?.trim() || sale.category?.trim() || 'Sem produto';
      const current = totals.get(name) || { revenue: 0, count: 0 };
      current.revenue += this.toNumber(sale.amount);
      current.count += 1;
      totals.set(name, current);
    });

    return Array.from(totals.entries())
      .sort((a, b) => b[1].revenue - a[1].revenue)
      .slice(0, 8)
      .map(([name, item]) => ({
        name,
        revenue: this.round(item.revenue),
        count: item.count,
      }));
  }

  private buildCostsByCategory(
    operationalCosts: Array<{ amount: Prisma.Decimal; category: string | null; name: string }>,
    transactions: Array<{ amount: Prisma.Decimal; type: FinancialTransactionType; category: string | null; description: string }>,
    adSpends: Array<{ amount: Prisma.Decimal; source: string }>,
  ): DashboardChartPoint[] {
    const totals = new Map<string, number>();
    operationalCosts.forEach((cost) => {
      const key = cost.category?.trim() || cost.name?.trim() || 'Operacional';
      totals.set(key, (totals.get(key) || 0) + this.toNumber(cost.amount));
    });
    transactions
      .filter((transaction) => transaction.type === FinancialTransactionType.EXPENSE)
      .forEach((transaction) => {
        const key = transaction.category?.trim() || transaction.description?.trim() || 'Despesa';
        totals.set(key, (totals.get(key) || 0) + this.toNumber(transaction.amount));
      });
    adSpends.forEach((spend) => {
      const key = spend.source?.trim() || 'Marketing';
      totals.set(key, (totals.get(key) || 0) + this.toNumber(spend.amount));
    });

    return Array.from(totals.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([name, value]) => ({
        name,
        value: this.round(value),
      }));
  }

  private buildPeakSalesHours(
    sales: Array<{ amount: Prisma.Decimal; occurredAt: Date }>,
    timeZone: string,
  ): DashboardChartPoint[] {
    const buckets = new Map<string, { count: number; revenue: number }>();
    for (let hour = 0; hour < 24; hour += 1) {
      buckets.set(`${String(hour).padStart(2, '0')}:00`, { count: 0, revenue: 0 });
    }

    sales.forEach((sale) => {
      const zonedDate = toZonedTime(sale.occurredAt, timeZone);
      const key = `${String(zonedDate.getHours()).padStart(2, '0')}:00`;
      const bucket = buckets.get(key);
      if (!bucket) return;
      bucket.count += 1;
      bucket.revenue += this.toNumber(sale.amount);
    });

    return Array.from(buckets.entries())
      .map(([name, item]) => ({ name, count: item.count, revenue: this.round(item.revenue) }))
      .filter((item) => item.count > 0)
      .sort((a, b) => Number(b.count) - Number(a.count));
  }

  private getDailyLabels(start: Date, end: Date, timeZone: string): string[] {
    const labels: string[] = [];
    const cursor = toZonedTime(start, timeZone);
    const zonedEnd = toZonedTime(end, timeZone);
    cursor.setHours(0, 0, 0, 0);
    zonedEnd.setHours(0, 0, 0, 0);

    while (cursor <= zonedEnd) {
      labels.push(this.getDayLabel(cursor));
      cursor.setDate(cursor.getDate() + 1);
    }

    return labels;
  }

  private getDayLabel(date: Date): string {
    return new Intl.DateTimeFormat('pt-BR', {
      day: '2-digit',
      month: '2-digit',
    }).format(date);
  }

  private normalizePeriod(period?: string): DashboardPeriod {
    switch ((period || '').trim().toLowerCase()) {
      case 'yesterday':
        return 'yesterday';
      case 'week':
        return 'week';
      case 'month':
        return 'month';
      case 'year':
        return 'year';
      default:
        return 'today';
    }
  }

  private resolvePeriodRange(period: DashboardPeriod, timeZone: string) {
    const nowUtc = new Date();
    const zonedNow = toZonedTime(nowUtc, timeZone);
    const endZoned = new Date(zonedNow);
    let startZoned = new Date(zonedNow);

    if (period === 'today') {
      startZoned.setHours(0, 0, 0, 0);
    } else if (period === 'yesterday') {
      startZoned.setDate(startZoned.getDate() - 1);
      startZoned.setHours(0, 0, 0, 0);
      endZoned.setDate(endZoned.getDate() - 1);
      endZoned.setHours(23, 59, 59, 999);
    } else if (period === 'week') {
      startZoned.setDate(startZoned.getDate() - 6);
      startZoned.setHours(0, 0, 0, 0);
      endZoned.setHours(23, 59, 59, 999);
    } else if (period === 'month') {
      startZoned.setDate(startZoned.getDate() - 29);
      startZoned.setHours(0, 0, 0, 0);
      endZoned.setHours(23, 59, 59, 999);
    } else {
      startZoned = new Date(zonedNow.getFullYear(), zonedNow.getMonth() - 11, 1, 0, 0, 0, 0);
      endZoned.setHours(23, 59, 59, 999);
    }

    const start = fromZonedTime(startZoned, timeZone);
    const end = fromZonedTime(endZoned, timeZone);

    return { start, end };
  }

  private buildTimeline(
    period: DashboardPeriod,
    start: Date,
    end: Date,
    sales: Array<{ amount: Prisma.Decimal; occurredAt: Date }>,
    transactions: Array<{
      amount: Prisma.Decimal;
      type: FinancialTransactionType;
      occurredAt: Date;
    }>,
    adSpends: Array<{ amount: Prisma.Decimal; spentAt: Date }>,
    timeZone: string,
  ): TimelinePoint[] {
    const bucketMap = new Map<string, TimelinePoint>();
    const labels = this.getTimelineLabels(period, start, end, timeZone);

    for (const label of labels) {
      bucketMap.set(label, { name: label, Receitas: 0, Saidas: 0 });
    }

    for (const sale of sales) {
      const zonedDate = toZonedTime(sale.occurredAt, timeZone);
      const label = this.getLabelForDate(zonedDate, period);
      const bucket = bucketMap.get(label);
      if (bucket) {
        bucket.Receitas += this.toNumber(sale.amount);
      }
    }

    for (const item of transactions) {
      const zonedDate = toZonedTime(item.occurredAt, timeZone);
      const label = this.getLabelForDate(zonedDate, period);
      const bucket = bucketMap.get(label);
      if (!bucket) continue;

      if (item.type === FinancialTransactionType.INCOME) {
        bucket.Receitas += this.toNumber(item.amount);
      } else {
        bucket.Saidas += this.toNumber(item.amount);
      }
    }

    for (const spend of adSpends) {
      const zonedDate = toZonedTime(spend.spentAt, timeZone);
      const label = this.getLabelForDate(zonedDate, period);
      const bucket = bucketMap.get(label);
      if (bucket) {
        bucket.Saidas += this.toNumber(spend.amount);
      }
    }

    return Array.from(bucketMap.values()).map((item) => ({
      ...item,
      Receitas: this.round(item.Receitas),
      Saidas: this.round(item.Saidas),
    }));
  }

  private getTimelineLabels(period: DashboardPeriod, start: Date, end: Date, timeZone: string): string[] {
    const labels: string[] = [];
    const zonedStart = toZonedTime(start, timeZone);
    const zonedEnd = toZonedTime(end, timeZone);
    const cursor = new Date(zonedStart);

    if (period === 'today' || period === 'yesterday') {
      for (let hour = 0; hour < 24; hour += 4) {
        labels.push(`${String(hour).padStart(2, '0')}:00`);
      }
      return labels;
    }

    if (period === 'year') {
      cursor.setDate(1);
      for (let i = 0; i < 12; i += 1) {
        const current = new Date(cursor.getFullYear(), cursor.getMonth() + i, 1);
        labels.push(this.getLabelForDate(current, period));
      }
      return labels;
    }

    while (cursor <= zonedEnd) {
      labels.push(this.getLabelForDate(cursor, period));
      cursor.setDate(cursor.getDate() + 1);
    }

    return labels;
  }

  private getLabelForDate(date: Date, period: DashboardPeriod): string {
    if (period === 'today' || period === 'yesterday') {
      const hourBucket = Math.floor(date.getHours() / 4) * 4;
      return `${String(hourBucket).padStart(2, '0')}:00`;
    }

    if (period === 'year') {
      return new Intl.DateTimeFormat('pt-BR', { month: 'short' }).format(date);
    }

    return new Intl.DateTimeFormat('pt-BR', {
      day: '2-digit',
      month: '2-digit',
    }).format(date);
  }

  private buildPieData(
    sales: Array<{ amount: Prisma.Decimal; category: string | null; productName: string | null }>,
    transactions: Array<{
      amount: Prisma.Decimal;
      type: FinancialTransactionType;
      category: string | null;
      description: string;
    }>,
    adSpends: Array<{ amount: Prisma.Decimal; source: string }>,
  ): PiePoint[] {
    const totals = new Map<string, number>();

    for (const sale of sales) {
      const key = sale.category?.trim() || sale.productName?.trim() || 'Vendas';
      totals.set(key, (totals.get(key) || 0) + this.toNumber(sale.amount));
    }

    for (const item of transactions) {
      if (item.type !== FinancialTransactionType.INCOME) continue;
      const key = item.category?.trim() || item.description?.trim() || 'Receita';
      totals.set(key, (totals.get(key) || 0) + this.toNumber(item.amount));
    }

    if (totals.size === 0) {
      for (const spend of adSpends) {
        const key = spend.source?.trim() || 'Marketing';
        totals.set(key, (totals.get(key) || 0) + this.toNumber(spend.amount));
      }
    }

    return Array.from(totals.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([name, value]) => ({
        name: name.toUpperCase(),
        value: this.round(value),
      }));
  }

  private zeroSummary(
    companyCount: number,
    period: DashboardPeriod,
  ): DashboardSummaryDto {
    return {
      revenue: 0,
      losses: 0,
      profit: 0,
      cashflow: 0,
      companyCount,
      lineData: [],
      pieData: [],
      period,
    };
  }

  private zeroFinancialSummary(): DashboardFinancialDto {
    return {
      totalIncome: 0,
      totalExpense: 0,
      balance: 0,
      transactionsCount: 0,
    };
  }

  private toNumber(value: Prisma.Decimal | number | null | undefined): number {
    return Number(value ?? 0);
  }

  private jsonNumber(value: Prisma.JsonValue | null | undefined): number {
    if (typeof value === 'number') return value;
    if (typeof value === 'string') {
      const compact = value.replace(/\s+/g, '');
      const commaIndex = compact.lastIndexOf(',');
      const dotIndex = compact.lastIndexOf('.');
      let normalized = compact;
      if (commaIndex >= 0 && dotIndex >= 0) {
        normalized =
          commaIndex > dotIndex
            ? compact.replace(/\./g, '').replace(',', '.')
            : compact.replace(/,/g, '');
      } else if (commaIndex >= 0) {
        normalized = compact.replace(',', '.');
      }
      normalized = normalized.replace(/[^\d.-]/g, '');
      const numeric = Number(normalized);
      return Number.isFinite(numeric) ? numeric : 0;
    }
    return 0;
  }

  private round(value: number): number {
    return Math.round((value + Number.EPSILON) * 100) / 100;
  }
}
