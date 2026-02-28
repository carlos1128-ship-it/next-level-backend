import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma, FinancialTransactionType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateTransactionDto } from './dto/create-transaction.dto';
import { ListTransactionsDto } from './dto/list-transactions.dto';

@Injectable()
export class FinanceService {
  constructor(private readonly prisma: PrismaService) {}

  async listTransactions(userId: string, query: ListTransactionsDto) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { companyId: true },
    });

    if (!user?.companyId) {
      return [];
    }

    const where: Prisma.FinancialTransactionWhereInput = {
      companyId: user.companyId,
      type: query.type,
      occurredAt: {
        gte: query.start ? new Date(query.start) : undefined,
        lte: query.end ? new Date(query.end) : undefined,
      },
    };

    return this.prisma.financialTransaction.findMany({
      where,
      orderBy: { occurredAt: 'desc' },
    });
  }

  async listTransactionsByCompany(
    userId: string,
    companyId: string,
    query: ListTransactionsDto,
  ) {
    const normalizedCompanyId = companyId?.trim();
    if (!normalizedCompanyId) {
      throw new BadRequestException('companyId nao informado');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { companyId: true },
    });

    if (!user) {
      throw new BadRequestException('Usuario nao encontrado');
    }

    if (!user.companyId || user.companyId !== normalizedCompanyId) {
      throw new BadRequestException(
        'companyId nao corresponde ao usuario autenticado',
      );
    }

    const company = await this.prisma.company.findUnique({
      where: { id: normalizedCompanyId },
      select: { id: true },
    });
    if (!company) {
      throw new BadRequestException('Empresa nao encontrada para o companyId informado');
    }

    const where: Prisma.FinancialTransactionWhereInput = {
      companyId: normalizedCompanyId,
      type: query.type,
      occurredAt: {
        gte: query.start ? new Date(query.start) : undefined,
        lte: query.end ? new Date(query.end) : undefined,
      },
    };

    return this.prisma.financialTransaction.findMany({
      where,
      orderBy: { occurredAt: 'desc' },
    });
  }

  async createTransaction(userId: string, dto: CreateTransactionDto) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { companyId: true },
    });

    if (!user) {
      throw new BadRequestException('Usuario nao encontrado');
    }
    if (!user.companyId) {
      throw new BadRequestException('User has no company');
    }
    const companyId = dto.companyId?.trim() || user.companyId || undefined;
    if (!companyId) {
      throw new BadRequestException('companyId nao informado');
    }

    if (user.companyId && companyId !== user.companyId) {
      throw new BadRequestException(
        'companyId nao corresponde ao usuario autenticado',
      );
    }

    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { id: true },
    });
    if (!company) {
      throw new BadRequestException('Empresa nao encontrada para o companyId informado');
    }

    const lowerType = dto.type?.toLowerCase();
    if (lowerType !== 'income' && lowerType !== 'expense') {
      throw new BadRequestException('type deve ser income ou expense');
    }

    const normalizedType =
      lowerType === 'income'
        ? FinancialTransactionType.INCOME
        : FinancialTransactionType.EXPENSE;

    const createdTransaction = await this.prisma.financialTransaction.create({
      data: {
        companyId,
        userId,
        type: normalizedType,
        amount: new Prisma.Decimal(dto.amount),
        description: dto.description.trim(),
        category: dto.category?.trim() || null,
        occurredAt: dto.occurredAt ? new Date(dto.occurredAt) : new Date(),
      },
    });

    const [incomeAggregate, expenseAggregate, transactionsCount] = await Promise.all([
      this.prisma.financialTransaction.aggregate({
        where: {
          companyId,
          type: FinancialTransactionType.INCOME,
        },
        _sum: { amount: true },
      }),
      this.prisma.financialTransaction.aggregate({
        where: {
          companyId,
          type: FinancialTransactionType.EXPENSE,
        },
        _sum: { amount: true },
      }),
      this.prisma.financialTransaction.count({
        where: { companyId },
      }),
    ]);

    const totalIncome = this.toNumber(incomeAggregate._sum.amount);
    const totalExpense = this.toNumber(expenseAggregate._sum.amount);
    const balance = totalIncome - totalExpense;

    return {
      transaction: createdTransaction,
      totalIncome: this.round(totalIncome),
      totalExpense: this.round(totalExpense),
      balance: this.round(balance),
      transactionsCount,
    };
  }

  private toNumber(value: Prisma.Decimal | number | null | undefined): number {
    return Number(value ?? 0);
  }

  private round(value: number): number {
    return Math.round((value + Number.EPSILON) * 100) / 100;
  }
}
