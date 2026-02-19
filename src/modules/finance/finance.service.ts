import { Injectable, NotFoundException } from '@nestjs/common';
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

  async createTransaction(userId: string, dto: CreateTransactionDto) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { companyId: true },
    });

    if (!user?.companyId) {
      throw new NotFoundException('Empresa nao encontrada para o usuario');
    }

    const normalizedType =
      dto.type === FinancialTransactionType.INCOME
        ? FinancialTransactionType.INCOME
        : FinancialTransactionType.EXPENSE;

    return this.prisma.financialTransaction.create({
      data: {
        companyId: user.companyId,
        userId,
        type: normalizedType,
        amount: new Prisma.Decimal(dto.amount),
        description: dto.description.trim(),
        category: dto.category?.trim() || null,
        occurredAt: new Date(dto.occurredAt),
      },
    });
  }
}
