import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SalesService } from '../sales/sales.service';

export interface InsightItem {
  type: string;
  title: string;
  description: string;
  value?: number | string;
  metadata?: Record<string, unknown>;
}

@Injectable()
export class InsightsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly salesService: SalesService,
  ) {}

  async getInsights(companyId: string, start: Date, end: Date): Promise<InsightItem[]> {
    const { sales, total, byProduct } =
      await this.salesService.getAggregatesByCompanyAndPeriod(companyId, start, end);

    const insights: InsightItem[] = [];

    if (sales.length === 0) {
      insights.push({
        type: 'info',
        title: 'Sem dados no período',
        description: 'Não há vendas no intervalo selecionado. Ajuste as datas ou registre vendas.',
      });
      return insights;
    }

    const avgTicket = total / sales.length;
    insights.push({
      type: 'metric',
      title: 'Ticket médio',
      description: `Valor médio por venda no período`,
      value: avgTicket.toFixed(2),
      metadata: { total, count: sales.length },
    });

    const byHour: Record<number, number> = {};
    for (let h = 0; h < 24; h++) byHour[h] = 0;
    for (const s of sales) {
      const h = new Date(s.occurredAt).getHours();
      byHour[h] += Number(s.amount);
    }
    const peakHour = Object.entries(byHour).reduce((a, b) =>
      (byHour[Number(a[0])] ?? 0) >= (byHour[Number(b[0])] ?? 0) ? a : b,
    );
    insights.push({
      type: 'peak',
      title: 'Horário de pico',
      description: `Maior volume de vendas às ${peakHour[0].padStart(2, '0')}:00`,
      value: Number(peakHour[0]),
      metadata: { revenue: byHour[Number(peakHour[0])] },
    });

    const productEntries = Object.entries(byProduct).sort((a, b) => b[1].total - a[1].total);
    if (productEntries.length > 0) {
      const [topProduct] = productEntries;
      insights.push({
        type: 'product',
        title: 'Produto com maior faturamento',
        description: `${topProduct[0]} liderou em valor no período`,
        value: topProduct[0],
        metadata: { total: topProduct[1].total, count: topProduct[1].count },
      });
    }

    const lastWeekStart = new Date(end);
    lastWeekStart.setDate(lastWeekStart.getDate() - 7);
    const prevWeek = await this.salesService.getAggregatesByCompanyAndPeriod(
      companyId,
      lastWeekStart,
      new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000),
    );
    const prevTotal = prevWeek.total;
    if (prevTotal > 0) {
      const growth = ((total - prevTotal) / prevTotal) * 100;
      insights.push({
        type: growth >= 0 ? 'growth' : 'alert',
        title: growth >= 0 ? 'Crescimento vs semana anterior' : 'Queda vs semana anterior',
        description: `${growth >= 0 ? '+' : ''}${growth.toFixed(1)}% em relação à semana anterior`,
        value: `${growth >= 0 ? '+' : ''}${growth.toFixed(1)}%`,
        metadata: { current: total, previous: prevTotal },
      });
    }

    return insights;
  }
}
