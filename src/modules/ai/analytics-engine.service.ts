import { Injectable } from '@nestjs/common';
import { FinancialTransactionType, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { BusinessMetricSnapshot, BusinessPeriod } from './business-intelligence.types';

@Injectable()
export class AnalyticsEngineService {
  constructor(private readonly prisma: PrismaService) {}

  async calculateMetrics(companyId: string, period: string = '30d'): Promise<BusinessMetricSnapshot> {
    const normalizedPeriod = this.normalizePeriod(period);
    const { start, end } = this.resolvePeriodRange(normalizedPeriod);
    const previousStart = new Date(start);
    previousStart.setTime(start.getTime() - (end.getTime() - start.getTime()));

    const [
      sales,
      previousSales,
      transactions,
      costs,
      adSpends,
      customers,
      products,
      customerCount,
      productCount,
    ] = await Promise.all([
      this.prisma.sale.findMany({
        where: { companyId, occurredAt: { gte: start, lte: end } },
        select: { amount: true, productName: true, category: true, occurredAt: true },
      }),
      this.prisma.sale.findMany({
        where: { companyId, occurredAt: { gte: previousStart, lt: start } },
        select: { amount: true },
      }),
      this.prisma.financialTransaction.findMany({
        where: { companyId, occurredAt: { gte: start, lte: end } },
        select: { type: true, amount: true },
      }),
      this.prisma.operationalCost.findMany({
        where: { companyId, date: { gte: start, lte: end } },
        select: { amount: true, category: true, name: true },
      }),
      this.prisma.adSpend.findMany({
        where: { companyId, spentAt: { gte: start, lte: end } },
        select: { amount: true },
      }),
      this.prisma.customer.findMany({
        where: { companyId },
        select: { id: true, createdAt: true },
      }),
      this.prisma.product.findMany({
        where: { companyId },
        select: { name: true, cost: true, tax: true, shipping: true },
      }),
      this.prisma.customer.count({ where: { companyId } }),
      this.prisma.product.count({ where: { companyId } }),
    ]);

    const saleRevenue = sales.reduce((total, sale) => total + this.toNumber(sale.amount), 0);
    const incomeRevenue = transactions
      .filter((item) => item.type === FinancialTransactionType.INCOME)
      .reduce((total, item) => total + this.toNumber(item.amount), 0);
    const revenue = this.round(saleRevenue + incomeRevenue);
    const previousRevenue = previousSales.reduce((total, sale) => total + this.toNumber(sale.amount), 0);
    const transactionExpenses = transactions
      .filter((item) => item.type === FinancialTransactionType.EXPENSE)
      .reduce((total, item) => total + this.toNumber(item.amount), 0);
    const operationalCosts = costs.reduce((total, item) => total + this.toNumber(item.amount), 0);
    const adSpend = adSpends.reduce((total, item) => total + this.toNumber(item.amount), 0);
    const costsTotal = this.round(transactionExpenses + operationalCosts + adSpend);
    const profit = this.round(revenue - costsTotal);
    const salesCount = sales.length + transactions.filter((item) => item.type === FinancialTransactionType.INCOME).length;
    const averageTicket = salesCount > 0 ? this.round(revenue / salesCount) : null;
    const margin = revenue > 0 ? this.round((profit / revenue) * 100) : null;
    const operationalWaste = revenue > 0 ? this.round((operationalCosts / revenue) * 100) : null;
    const productCostByName = new Map<string, number>();
    products.forEach((product) => {
      productCostByName.set(
        product.name.trim().toLowerCase(),
        this.toNumber(product.cost) + this.toNumber(product.tax) + this.toNumber(product.shipping),
      );
    });

    const salesByProductMap = new Map<string, { revenue: number; salesCount: number }>();
    sales.forEach((sale) => {
      const productName = sale.productName?.trim() || sale.category?.trim() || 'Sem produto';
      const current = salesByProductMap.get(productName) || { revenue: 0, salesCount: 0 };
      current.revenue += this.toNumber(sale.amount);
      current.salesCount += 1;
      salesByProductMap.set(productName, current);
    });

    const salesByProduct = Array.from(salesByProductMap.entries())
      .map(([productName, item]) => ({
        productName,
        revenue: this.round(item.revenue),
        salesCount: item.salesCount,
      }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 8);

    const profitByProduct = salesByProduct.map((item) => {
      const unitCost = productCostByName.get(item.productName.trim().toLowerCase()) || 0;
      const estimatedCost = unitCost * item.salesCount;
      const estimatedProfit = item.revenue - estimatedCost;
      return {
        productName: item.productName,
        revenue: item.revenue,
        estimatedCost: this.round(estimatedCost),
        estimatedProfit: this.round(estimatedProfit),
        margin: item.revenue > 0 ? this.round((estimatedProfit / item.revenue) * 100) : null,
      };
    });

    const peakHourMap = new Map<number, { salesCount: number; revenue: number }>();
    sales.forEach((sale) => {
      const hour = sale.occurredAt.getHours();
      const current = peakHourMap.get(hour) || { salesCount: 0, revenue: 0 };
      current.salesCount += 1;
      current.revenue += this.toNumber(sale.amount);
      peakHourMap.set(hour, current);
    });

    const peakHours = Array.from(peakHourMap.entries())
      .map(([hour, item]) => ({ hour, salesCount: item.salesCount, revenue: this.round(item.revenue) }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 5);

    const inactiveCustomers = customers.filter((customer) => customer.createdAt < start).length;
    const risks = this.detectRisks({ revenue, previousRevenue, margin, operationalWaste, salesCount });
    const opportunities = this.detectOpportunities({ revenue, margin, salesByProduct, peakHours });

    return {
      period: {
        key: normalizedPeriod,
        startDate: start.toISOString(),
        endDate: end.toISOString(),
      },
      revenue,
      costs: costsTotal,
      profit,
      margin,
      averageTicket,
      salesCount,
      customerCount,
      productCount,
      inactiveCustomers,
      operationalWaste,
      salesByProduct,
      profitByProduct,
      peakHours,
      risks,
      opportunities,
    };
  }

  async calculateRevenue(companyId: string, period?: string) {
    return (await this.calculateMetrics(companyId, period)).revenue;
  }

  async calculateProfit(companyId: string, period?: string) {
    return (await this.calculateMetrics(companyId, period)).profit;
  }

  async calculateMargin(companyId: string, period?: string) {
    return (await this.calculateMetrics(companyId, period)).margin;
  }

  async calculateAverageTicket(companyId: string, period?: string) {
    return (await this.calculateMetrics(companyId, period)).averageTicket;
  }

  async calculateSalesByProduct(companyId: string, period?: string) {
    return (await this.calculateMetrics(companyId, period)).salesByProduct;
  }

  async calculateProfitByProduct(companyId: string, period?: string) {
    return (await this.calculateMetrics(companyId, period)).profitByProduct;
  }

  async detectSalesDrop(companyId: string, period?: string) {
    return (await this.calculateMetrics(companyId, period)).risks.includes('sales_drop');
  }

  async detectCostIncrease(companyId: string, period?: string) {
    return (await this.calculateMetrics(companyId, period)).risks.includes('cost_pressure');
  }

  async detectInactiveCustomers(companyId: string, period?: string) {
    return (await this.calculateMetrics(companyId, period)).inactiveCustomers;
  }

  async detectPeakHours(companyId: string, period?: string) {
    return (await this.calculateMetrics(companyId, period)).peakHours;
  }

  async calculateOperationalWaste(companyId: string, period?: string) {
    return (await this.calculateMetrics(companyId, period)).operationalWaste;
  }

  private detectRisks(input: {
    revenue: number;
    previousRevenue: number;
    margin: number | null;
    operationalWaste: number | null;
    salesCount: number;
  }) {
    const risks: string[] = [];
    if (input.salesCount === 0) risks.push('no_sales_data');
    if (input.previousRevenue > 0 && input.revenue < input.previousRevenue * 0.85) risks.push('sales_drop');
    if (input.margin !== null && input.margin < 15) risks.push('low_margin');
    if (input.operationalWaste !== null && input.operationalWaste > 30) risks.push('operational_waste');
    if (input.revenue > 0 && input.margin !== null && input.margin < 25) risks.push('cost_pressure');
    return risks;
  }

  private detectOpportunities(input: {
    revenue: number;
    margin: number | null;
    salesByProduct: Array<{ productName: string; revenue: number; salesCount: number }>;
    peakHours: Array<{ hour: number; salesCount: number; revenue: number }>;
  }) {
    const opportunities: string[] = [];
    if (input.salesByProduct.length > 0) opportunities.push('best_product_campaign');
    if (input.peakHours.length > 0) opportunities.push('peak_hour_campaign');
    if (input.revenue > 0 && input.margin !== null && input.margin >= 30) opportunities.push('scale_profitable_sales');
    return opportunities;
  }

  private normalizePeriod(period: string): BusinessPeriod {
    if (period === 'today' || period === 'yesterday' || period === '7d' || period === '30d' || period === 'month' || period === 'year') {
      return period;
    }
    return '30d';
  }

  private resolvePeriodRange(period: BusinessPeriod) {
    const end = new Date();
    const start = new Date(end);
    if (period === 'today') {
      start.setHours(0, 0, 0, 0);
    } else if (period === 'yesterday') {
      start.setDate(start.getDate() - 1);
      start.setHours(0, 0, 0, 0);
      end.setDate(end.getDate() - 1);
      end.setHours(23, 59, 59, 999);
    } else if (period === '7d') {
      start.setDate(start.getDate() - 7);
    } else if (period === 'month') {
      start.setDate(1);
      start.setHours(0, 0, 0, 0);
    } else if (period === 'year') {
      start.setMonth(0, 1);
      start.setHours(0, 0, 0, 0);
    } else {
      start.setDate(start.getDate() - 30);
    }
    return { start, end };
  }

  private toNumber(value: Prisma.Decimal | number | null | undefined) {
    return Number(value || 0);
  }

  private round(value: number) {
    return Number(value.toFixed(2));
  }
}
