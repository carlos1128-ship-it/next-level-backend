import { Injectable } from '@nestjs/common';
import { FinancialTransactionType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ExportFinancialQueryDto } from './dto/export-financial-query.dto';

type ExportRow = {
  date: string;
  source: string;
  type: 'INCOME' | 'EXPENSE';
  description: string;
  category: string;
  amount: number;
};

@Injectable()
export class ExportService {
  constructor(private readonly prisma: PrismaService) {}

  async getFinancialCsv(userId: string, query: ExportFinancialQueryDto): Promise<string> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { companyId: true },
    });

    if (!user?.companyId) {
      return this.toCsv([]);
    }

    const start = query.start ? new Date(query.start) : undefined;
    const end = query.end ? new Date(query.end) : undefined;
    const dateFilter = {
      gte: start,
      lte: end,
    };

    const [transactions, sales, adSpends] = await Promise.all([
      this.prisma.financialTransaction.findMany({
        where: {
          companyId: user.companyId,
          occurredAt: dateFilter,
        },
      }),
      this.prisma.sale.findMany({
        where: {
          companyId: user.companyId,
          occurredAt: dateFilter,
        },
      }),
      this.prisma.adSpend.findMany({
        where: {
          companyId: user.companyId,
          spentAt: dateFilter,
        },
      }),
    ]);

    const rows: ExportRow[] = [];

    for (const item of transactions) {
      rows.push({
        date: item.occurredAt.toISOString(),
        source: 'financial_transaction',
        type: item.type === FinancialTransactionType.INCOME ? 'INCOME' : 'EXPENSE',
        description: item.description,
        category: item.category || '',
        amount: Number(item.amount),
      });
    }

    for (const sale of sales) {
      rows.push({
        date: sale.occurredAt.toISOString(),
        source: 'sale',
        type: 'INCOME',
        description: sale.productName || 'Venda',
        category: sale.category || '',
        amount: Number(sale.amount),
      });
    }

    for (const spend of adSpends) {
      rows.push({
        date: spend.spentAt.toISOString(),
        source: 'ad_spend',
        type: 'EXPENSE',
        description: `Gasto em ${spend.source}`,
        category: 'marketing',
        amount: Number(spend.amount),
      });
    }

    rows.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
    return this.toCsv(rows);
  }

  private toCsv(rows: ExportRow[]): string {
    const header = 'date,source,type,description,category,amount';
    if (rows.length === 0) {
      return `${header}\n`;
    }

    const lines = rows.map((row) => {
      const values = [
        row.date,
        row.source,
        row.type,
        row.description,
        row.category,
        row.amount.toFixed(2),
      ];
      return values.map((value) => this.escapeCsv(value)).join(',');
    });

    return [header, ...lines].join('\n');
  }

  private escapeCsv(value: string): string {
    const shouldQuote = /[",\n]/.test(value);
    const escaped = value.replace(/"/g, '""');
    return shouldQuote ? `"${escaped}"` : escaped;
  }
}
