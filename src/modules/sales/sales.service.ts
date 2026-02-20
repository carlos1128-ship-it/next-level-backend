import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, SaleChannel } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateSaleDto } from './dto/create-sale.dto';
import { UpdateSaleDto } from './dto/update-sale.dto';

export interface PeriodAggregates {
  sales: Array<{
    amount: unknown;
    occurredAt: Date;
    productName: string | null;
    category: string | null;
  }>;
  total: number;
  byProduct: Record<string, { count: number; total: number }>;
}

export interface DashboardAggregatesDto {
  today: number;
  yesterday: number;
  week: number;
  month: number;
  year: number;
}

@Injectable()
export class SalesService {
  constructor(private readonly prisma: PrismaService) {}

  async create(userId: string, dto: CreateSaleDto) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { companyId: true },
    });

    if (!user) {
      throw new NotFoundException('Usuario nao encontrado');
    }
    if (!user.companyId) {
      throw new BadRequestException('User has no company');
    }

    return this.prisma.sale.create({
      data: {
        userId,
        companyId: user.companyId,
        amount: new Prisma.Decimal(dto.amount),
        productName: dto.productName ?? null,
        category: dto.category ?? null,
        channel: SaleChannel.manual,
        occurredAt: new Date(dto.occurredAt),
      },
    });
  }

  async findByUserAndPeriod(userId: string, start: Date, end: Date) {
    return this.prisma.sale.findMany({
      where: {
        userId,
        occurredAt: { gte: start, lte: end },
      },
      orderBy: { occurredAt: 'desc' },
    });
  }

  async update(id: string, userId: string, dto: UpdateSaleDto) {
    const existing = await this.prisma.sale.findFirst({ where: { id, userId } });
    if (!existing) {
      throw new NotFoundException('Venda nao encontrada');
    }

    return this.prisma.sale.update({
      where: { id },
      data: {
        amount: dto.amount != null ? new Prisma.Decimal(dto.amount) : undefined,
        productName: dto.productName,
        category: dto.category,
        occurredAt: dto.occurredAt ? new Date(dto.occurredAt) : undefined,
      },
    });
  }

  async remove(id: string, userId: string) {
    const existing = await this.prisma.sale.findFirst({ where: { id, userId } });
    if (!existing) {
      throw new NotFoundException('Venda nao encontrada');
    }

    await this.prisma.sale.delete({ where: { id } });
    return { deleted: true };
  }

  async getAggregatesByUserAndPeriod(
    userId: string,
    start: Date,
    end: Date,
  ): Promise<PeriodAggregates> {
    const sales = await this.findByUserAndPeriod(userId, start, end);
    const total = sales.reduce(
      (acc: number, s: { amount: unknown }) => acc + Number(s.amount),
      0,
    );
    const byProduct = sales.reduce<Record<string, { count: number; total: number }>>(
      (
        acc,
        s: { productName: string | null; category: string | null; amount: unknown },
      ) => {
        const name = s.productName ?? s.category ?? 'Sem nome';
        if (!acc[name]) acc[name] = { count: 0, total: 0 };
        acc[name].count += 1;
        acc[name].total += Number(s.amount);
        return acc;
      },
      {},
    );

    return {
      sales: sales.map((s) => ({
        amount: s.amount,
        occurredAt: s.occurredAt,
        productName: s.productName,
        category: s.category,
      })),
      total,
      byProduct,
    };
  }

  async getAggregatesByCompanyAndPeriod(
    companyId: string,
    start: Date,
    end: Date,
  ): Promise<PeriodAggregates> {
    const sales = await this.prisma.sale.findMany({
      where: {
        companyId,
        occurredAt: { gte: start, lte: end },
      },
      orderBy: { occurredAt: 'desc' },
    });

    const total = sales.reduce(
      (acc: number, s: { amount: unknown }) => acc + Number(s.amount),
      0,
    );
    const byProduct = sales.reduce<Record<string, { count: number; total: number }>>(
      (
        acc,
        s: { productName: string | null; category: string | null; amount: unknown },
      ) => {
        const name = s.productName ?? s.category ?? 'Sem nome';
        if (!acc[name]) acc[name] = { count: 0, total: 0 };
        acc[name].count += 1;
        acc[name].total += Number(s.amount);
        return acc;
      },
      {},
    );

    return {
      sales: sales.map((s) => ({
        amount: s.amount,
        occurredAt: s.occurredAt,
        productName: s.productName,
        category: s.category,
      })),
      total,
      byProduct,
    };
  }

  async getDashboardAggregates(userId: string): Promise<DashboardAggregatesDto> {
    const now = new Date();
    const startOfToday = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0),
    );
    const endOfToday = new Date(startOfToday.getTime() + 24 * 60 * 60 * 1000 - 1);
    const startOfYesterday = new Date(startOfToday.getTime() - 24 * 60 * 60 * 1000);
    const startOfWeek = new Date(startOfToday.getTime() - 6 * 24 * 60 * 60 * 1000);
    const startOfMonth = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0),
    );
    const startOfYear = new Date(Date.UTC(now.getUTCFullYear(), 0, 1, 0, 0, 0, 0));

    const [today, yesterday, week, month, year] = await Promise.all([
      this.sumByUserInPeriod(userId, startOfToday, endOfToday),
      this.sumByUserInPeriod(userId, startOfYesterday, startOfToday),
      this.sumByUserInPeriod(userId, startOfWeek, endOfToday),
      this.sumByUserInPeriod(userId, startOfMonth, endOfToday),
      this.sumByUserInPeriod(userId, startOfYear, endOfToday),
    ]);

    return { today, yesterday, week, month, year };
  }

  private async sumByUserInPeriod(
    userId: string,
    start: Date,
    end: Date,
  ): Promise<number> {
    const result = await this.prisma.sale.aggregate({
      where: {
        userId,
        occurredAt: { gte: start, lte: end },
      },
      _sum: { amount: true },
    });
    return Number(result._sum?.amount ?? 0);
  }
}
