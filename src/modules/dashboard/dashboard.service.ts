import { BadRequestException, Injectable } from '@nestjs/common';
import { FinancialTransactionType, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { toZonedTime, fromZonedTime } from 'date-fns-tz';

type DashboardPeriod = 'today' | 'yesterday' | 'week' | 'month' | 'year';

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
}

export interface DashboardFinancialDto {
  totalIncome: number;
  totalExpense: number;
  balance: number;
  transactionsCount: number;
}

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
    };
  }

  private async resolveCompanyId(
    userId: string,
    requestedCompanyId?: string,
    fallbackCompanyId?: string | null,
  ): Promise<string | null> {
    if (requestedCompanyId?.trim()) {
      const company = await this.prisma.company.findFirst({
        where: {
          id: requestedCompanyId.trim(),
          OR: [{ userId }, { users: { some: { id: userId } } }],
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

  private round(value: number): number {
    return Math.round((value + Number.EPSILON) * 100) / 100;
  }
}
