import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

export interface ProfitRow {
  revenue: number;
  cost: number;
  profit: number;
}

@Injectable()
export class AnalyticsService {
  constructor(private prisma: PrismaService) {}

  private async resolveCompanyId(
    userId: string,
    companyId?: string | null,
  ): Promise<string> {
    const normalizedCompanyId =
      companyId?.trim() ||
      (
        await this.prisma.user.findUnique({
          where: { id: userId },
          select: { companyId: true },
        })
      )?.companyId?.trim();

    if (!normalizedCompanyId) {
      throw new BadRequestException('companyId nao informado');
    }

    const company = await this.prisma.company.findFirst({
      where: {
        id: normalizedCompanyId,
        OR: [{ userId }, { users: { some: { id: userId } } }],
      },
      select: { id: true },
    });

    if (!company) {
      throw new BadRequestException('Empresa invalida');
    }

    return company.id;
  }

  private toNumber(value: Prisma.Decimal | number | null | undefined): number {
    return Number(value ?? 0);
  }

  async profitByProduct(userId: string, companyId?: string) {
    const resolvedCompanyId = await this.resolveCompanyId(userId, companyId);

    const [sales, products] = await Promise.all([
      this.prisma.sale.findMany({
        where: { companyId: resolvedCompanyId },
        select: { amount: true, productName: true, category: true },
      }),
      this.prisma.product.findMany({
        where: { companyId: resolvedCompanyId },
        select: { name: true, cost: true },
      }),
    ]);

    const costByProduct = new Map<string, number>();
    products.forEach((product) =>
      costByProduct.set(product.name.trim().toLowerCase(), this.toNumber(product.cost)),
    );

    const result = new Map<string, ProfitRow>();

    sales.forEach((sale) => {
      const label =
        sale.productName?.trim() ||
        sale.category?.trim() ||
        'Sem nome';
      const key = label.toLowerCase();
      const revenue = this.toNumber(sale.amount);
      const cost = costByProduct.get(key) ?? 0;
      const profit = revenue - cost;

      const current = result.get(label) || { revenue: 0, cost: 0, profit: 0 };
      current.revenue += revenue;
      current.cost += cost;
      current.profit += profit;
      result.set(label, current);
    });

    return Object.fromEntries(result.entries());
  }

  async margin(userId: string, companyId?: string) {
    const resolvedCompanyId = await this.resolveCompanyId(userId, companyId);

    const [sales, products, operationalCosts] = await Promise.all([
      this.prisma.sale.findMany({
        where: { companyId: resolvedCompanyId },
        select: { amount: true, productName: true, category: true },
      }),
      this.prisma.product.findMany({
        where: { companyId: resolvedCompanyId },
        select: { name: true, cost: true },
      }),
      this.prisma.operationalCost.aggregate({
        where: { companyId: resolvedCompanyId },
        _sum: { amount: true },
      }),
    ]);

    const costByProduct = new Map<string, number>();
    products.forEach((product) =>
      costByProduct.set(product.name.trim().toLowerCase(), this.toNumber(product.cost)),
    );

    let revenue = 0;
    let productCosts = 0;

    sales.forEach((sale) => {
      const revenueValue = this.toNumber(sale.amount);
      revenue += revenueValue;
      const label =
        sale.productName?.trim() ||
        sale.category?.trim() ||
        'Sem nome';
      const cost = costByProduct.get(label.toLowerCase()) ?? 0;
      productCosts += cost;
    });

    const operationalCostsTotal = this.toNumber(operationalCosts._sum.amount);
    const totalCosts = operationalCostsTotal + productCosts;
    const profit = revenue - totalCosts;

    return {
      revenue,
      cost: totalCosts,
      profit,
      margin: revenue > 0 ? profit / revenue : 0,
    };
  }

  async salesPeak(userId: string, companyId?: string) {
    const resolvedCompanyId = await this.resolveCompanyId(userId, companyId);

    const sales = await this.prisma.sale.findMany({
      where: { companyId: resolvedCompanyId },
      select: { amount: true, occurredAt: true, createdAt: true },
    });

    const hours: Record<string, number> = {};

    sales.forEach((sale) => {
      const date = sale.occurredAt || sale.createdAt;
      const hour = new Date(date).getHours();
      const key = `${hour.toString().padStart(2, '0')}:00`;
      hours[key] = (hours[key] || 0) + this.toNumber(sale.amount);
    });

    return hours;
  }

  async operationalWaste(userId: string, companyId?: string) {
    const resolvedCompanyId = await this.resolveCompanyId(userId, companyId);

    const [revenue, costs] = await Promise.all([
      this.prisma.sale.aggregate({
        where: { companyId: resolvedCompanyId },
        _sum: { amount: true },
      }),
      this.prisma.operationalCost.aggregate({
        where: { companyId: resolvedCompanyId },
        _sum: { amount: true },
      }),
    ]);

    const revenueTotal = this.toNumber(revenue._sum.amount);
    const costTotal = this.toNumber(costs._sum.amount);

    return {
      revenue: revenueTotal,
      operationalCosts: costTotal,
      wastePercentage: revenueTotal > 0 ? costTotal / revenueTotal : 0,
    };
  }
}
