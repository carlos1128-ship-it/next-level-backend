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

  private zeroFinancialSummary(): DashboardFinancialDto {
    return {
      totalIncome: 0,
      totalExpense: 0,
      balance: 0,
      transactionsCount: 0,
    };
  }

  private toNumber(value: unknown): number {
    return Number(value ?? 0);
  }

  private round(value: number): number {
    return Math.round((value + Number.EPSILON) * 100) / 100;
  }
}
