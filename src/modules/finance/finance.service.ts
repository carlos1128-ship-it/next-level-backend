import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma, FinancialTransactionType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateTransactionDto } from './dto/create-transaction.dto';
import { ListTransactionsDto } from './dto/list-transactions.dto';

@Injectable()
export class FinanceService {
  constructor(private readonly prisma: PrismaService) {}

  private normalizeTransactionType(type: FinancialTransactionType) {
    return type === FinancialTransactionType.INCOME ? 'income' : 'expense';
  }

  private normalizeTransaction<T extends { type: FinancialTransactionType }>(transaction: T) {
    return {
      ...transaction,
      type: this.normalizeTransactionType(transaction.type),
    };
  }

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

    const transactions = await this.prisma.financialTransaction.findMany({
      where,
      orderBy: { occurredAt: 'desc' },
    });

    return transactions.map((transaction) => this.normalizeTransaction(transaction));
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

    const company = await this.prisma.company.findFirst({
      where: {
        id: normalizedCompanyId,
        users: { some: { id: userId } },
      },
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

    const transactions = await this.prisma.financialTransaction.findMany({
      where,
      orderBy: { occurredAt: 'desc' },
    });

    return transactions.map((transaction) => this.normalizeTransaction(transaction));
  }

  async createTransaction(dto: CreateTransactionDto, userId: string) {
    const normalizedCompanyId = dto.companyId?.trim();
    if (!normalizedCompanyId) {
      throw new BadRequestException('Empresa invalida');
    }
    const company = await this.prisma.company.findFirst({
      where: {
        id: normalizedCompanyId,
        users: { some: { id: userId } },
      },
      select: { id: true },
    });
    if (!company) {
      throw new BadRequestException('Empresa invalida');
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
        companyId: normalizedCompanyId,
        userId,
        type: normalizedType,
        amount: new Prisma.Decimal(dto.amount),
        description: dto.description.trim(),
        category: dto.category?.trim() || null,
        occurredAt: dto.occurredAt
          ? new Date(dto.occurredAt)
          : dto.date
            ? new Date(dto.date)
            : new Date(),
      },
    });

    const [incomeAggregate, expenseAggregate, transactionsCount] = await Promise.all([
      this.prisma.financialTransaction.aggregate({
        where: {
          companyId: normalizedCompanyId,
          type: FinancialTransactionType.INCOME,
        },
        _sum: { amount: true },
      }),
      this.prisma.financialTransaction.aggregate({
        where: {
          companyId: normalizedCompanyId,
          type: FinancialTransactionType.EXPENSE,
        },
        _sum: { amount: true },
      }),
      this.prisma.financialTransaction.count({
        where: { companyId: normalizedCompanyId },
      }),
    ]);

    const totalIncome = this.toNumber(incomeAggregate._sum.amount);
    const totalExpense = this.toNumber(expenseAggregate._sum.amount);
    const balance = totalIncome - totalExpense;

    return {
      transaction: this.normalizeTransaction(createdTransaction),
      totalIncome: this.round(totalIncome),
      totalExpense: this.round(totalExpense),
      balance: this.round(balance),
      transactionsCount,
    };
  }

  async findAll(companyId: string, userId: string) {
    const normalizedCompanyId = companyId?.trim();
    if (!normalizedCompanyId) {
      throw new BadRequestException('companyId nao informado');
    }

    const transactions = await this.prisma.financialTransaction.findMany({
      where: { companyId: normalizedCompanyId, userId },
      orderBy: { occurredAt: 'desc' },
    });

    return transactions.map((transaction) => this.normalizeTransaction(transaction));
  }

  private toNumber(value: Prisma.Decimal | number | null | undefined): number {
    return Number(value ?? 0);
  }

  private round(value: number): number {
    return Math.round((value + Number.EPSILON) * 100) / 100;
  }
}
