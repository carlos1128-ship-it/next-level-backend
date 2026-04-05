import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma, FinancialTransactionType } from '@prisma/client';
import { fromZonedTime } from 'date-fns-tz';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateTransactionDto } from './dto/create-transaction.dto';
import { ListTransactionsDto } from './dto/list-transactions.dto';

@Injectable()
export class FinanceService {
  private readonly transactionTimeZone = 'America/Sao_Paulo';

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

  private parseTransactionDate(value?: string) {
    if (!value) return new Date();

    const normalized = String(value).trim();
    if (!normalized) return new Date();

    const hasExplicitTimezone = /([zZ]|[+\-]\d{2}:\d{2})$/.test(normalized);
    const parsed = hasExplicitTimezone
      ? new Date(normalized)
      : fromZonedTime(normalized, this.transactionTimeZone);

    if (Number.isNaN(parsed.getTime())) {
      throw new BadRequestException('Data da transacao invalida');
    }

    return parsed;
  }

  private async ensureUserCompany(userId: string, companyId: string) {
    const company = await this.prisma.company.findFirst({
      where: {
        id: companyId,
        OR: [{ userId }, { users: { some: { id: userId } } }],
      },
      select: { id: true },
    });

    if (!company) {
      throw new BadRequestException('Empresa invalida');
    }

    return company;
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
      orderBy: { date: 'desc' },
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

    await this.ensureUserCompany(userId, normalizedCompanyId);

    const where: Prisma.FinancialTransactionWhereInput = {
      companyId: normalizedCompanyId,
      type: query.type,
      date: {
        gte: query.start ? new Date(query.start) : undefined,
        lte: query.end ? new Date(query.end) : undefined,
      },
    };

    const transactions = await this.prisma.financialTransaction.findMany({
      where,
      orderBy: { date: 'desc' },
    });

    return transactions.map((transaction) => this.normalizeTransaction(transaction));
  }

  async createTransaction(dto: CreateTransactionDto, userId: string) {
    const normalizedCompanyId = dto.companyId?.trim();
    if (!normalizedCompanyId) {
      throw new BadRequestException('Empresa invalida');
    }

    await this.ensureUserCompany(userId, normalizedCompanyId);

    const lowerType = dto.type?.toLowerCase();
    if (lowerType !== 'income' && lowerType !== 'expense') {
      throw new BadRequestException('type deve ser income ou expense');
    }

    const normalizedType =
      lowerType === 'income'
        ? FinancialTransactionType.INCOME
        : FinancialTransactionType.EXPENSE;

    const transactionDate = this.parseTransactionDate(dto.date || dto.occurredAt);

    const createdTransaction = await this.prisma.financialTransaction.create({
      data: {
        companyId: normalizedCompanyId,
        userId,
        type: normalizedType,
        amount: new Prisma.Decimal(dto.amount),
        description: dto.description.trim(),
        category: dto.category?.trim() || null,
        date: transactionDate,
        occurredAt: transactionDate,
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

    await this.ensureUserCompany(userId, normalizedCompanyId);

    const transactions = await this.prisma.financialTransaction.findMany({
      where: { companyId: normalizedCompanyId },
      orderBy: { date: 'desc' },
    });

    return transactions.map((transaction) => this.normalizeTransaction(transaction));
  }

  async getReport(companyId: string, userId: string) {
    const normalizedCompanyId = companyId?.trim();
    if (!normalizedCompanyId) {
      throw new BadRequestException('companyId nao informado');
    }

    await this.ensureUserCompany(userId, normalizedCompanyId);

    const [incomeAggregate, expenseAggregate] = await Promise.all([
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
    ]);

    const income = this.round(this.toNumber(incomeAggregate._sum.amount));
    const expense = this.round(this.toNumber(expenseAggregate._sum.amount));

    return {
      income,
      expense,
      balance: this.round(income - expense),
    };
  }

  private toNumber(value: Prisma.Decimal | number | null | undefined): number {
    return Number(value ?? 0);
  }

  private round(value: number): number {
    return Math.round((value + Number.EPSILON) * 100) / 100;
  }
}
