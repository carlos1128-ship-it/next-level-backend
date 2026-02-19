import { Injectable } from '@nestjs/common';
import { FinancialTransactionType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

export interface DashboardSummaryDto {
  revenue: number;
  expenses: number;
  profit: number;
  cashflow: number;
  companyCount: number;
}

@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async getSummary(userId: string): Promise<DashboardSummaryDto> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { companyId: true },
    });

    if (!user?.companyId) {
      return this.zeroSummary(0);
    }

    const companyCount = await this.prisma.company.count({
      where: { id: user.companyId },
    });

    if (companyCount === 0) {
      return this.zeroSummary(0);
    }

    const [salesRevenue, incomeTransactions, expenseTransactions, adSpends] =
      await Promise.all([
        this.prisma.sale.aggregate({
          where: { companyId: user.companyId },
          _sum: { amount: true },
        }),
        this.prisma.financialTransaction.aggregate({
          where: {
            companyId: user.companyId,
            type: FinancialTransactionType.INCOME,
          },
          _sum: { amount: true },
        }),
        this.prisma.financialTransaction.aggregate({
          where: {
            companyId: user.companyId,
            type: FinancialTransactionType.EXPENSE,
          },
          _sum: { amount: true },
        }),
        this.prisma.adSpend.aggregate({
          where: { companyId: user.companyId },
          _sum: { amount: true },
        }),
      ]);

    const revenue =
      this.toNumber(salesRevenue._sum.amount) +
      this.toNumber(incomeTransactions._sum.amount);
    const expenses =
      this.toNumber(expenseTransactions._sum.amount) +
      this.toNumber(adSpends._sum.amount);
    const profit = revenue - expenses;
    const cashflow = profit;

    return {
      revenue: this.round(revenue),
      expenses: this.round(expenses),
      profit: this.round(profit),
      cashflow: this.round(cashflow),
      companyCount,
    };
  }

  private zeroSummary(companyCount: number): DashboardSummaryDto {
    return {
      revenue: 0,
      expenses: 0,
      profit: 0,
      cashflow: 0,
      companyCount,
    };
  }

  private toNumber(value: unknown): number {
    return Number(value ?? 0);
  }

  private round(value: number): number {
    return Math.round((value + Number.EPSILON) * 100) / 100;
  }
}
