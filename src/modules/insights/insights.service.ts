import { Injectable } from '@nestjs/common';
import { FinancialTransactionType } from '@prisma/client';
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
    const [{ sales, total, byProduct }, expenses] = await Promise.all([
      this.salesService.getAggregatesByCompanyAndPeriod(companyId, start, end),
      this.prisma.financialTransaction.aggregate({
        where: {
          companyId,
          type: FinancialTransactionType.EXPENSE,
          occurredAt: { gte: start, lte: end },
        },
        _sum: { amount: true },
      }),
    ]);

    if (sales.length === 0) {
      return this.emptyStateInsights();
    }

    const insights: InsightItem[] = [];
    const expenseTotal = Number(expenses._sum.amount || 0);
    const avgTicket = total / sales.length;

    insights.push({
      type: 'action',
      title: 'Ticket medio para orientar ofertas',
      description:
        `Atenção: o ticket medio do periodo foi de ${this.money(avgTicket)}. Isso ajuda a definir combos, frete minimo e metas de atendimento sem adivinhar.`,
      value: this.money(avgTicket),
      metadata: {
        priority: 'Ação recomendada',
        diagnosis: 'As vendas ja mostram um valor medio por pedido.',
        whyItMatters: 'Ticket medio baixo pode exigir volume maior para sustentar lucro.',
        recommendedAction: 'Compare esse ticket com seus produtos mais vendidos e teste um combo acima desse valor.',
        total,
        count: sales.length,
      },
    });

    const peak = this.findPeakHour(sales);
    if (peak) {
      insights.push({
        type: 'opportunity',
        title: 'Horario com maior chance de venda',
        description:
          `Oportunidade: o maior volume de vendas apareceu perto de ${String(peak.hour).padStart(2, '0')}:00. Concentrar atendimento e ofertas nesse horario pode melhorar conversao.`,
        value: `${String(peak.hour).padStart(2, '0')}:00`,
        metadata: {
          priority: 'Oportunidade',
          diagnosis: 'Existe um horario do dia com concentracao maior de receita.',
          whyItMatters: 'Atendimento lento no horario certo costuma custar vendas.',
          recommendedAction: 'Reforce atendimento, campanhas e reposicao antes desse horario.',
          revenue: peak.revenue,
        },
      });
    }

    const topProduct = Object.entries(byProduct).sort((a, b) => b[1].total - a[1].total)[0];
    if (topProduct) {
      insights.push({
        type: 'growth',
        title: 'Produto que puxa faturamento',
        description:
          `Crescimento: ${topProduct[0]} liderou em faturamento no periodo. Antes de aumentar investimento, confirme margem, custo, frete e disponibilidade.`,
        value: topProduct[0],
        metadata: {
          priority: 'Crescimento',
          diagnosis: 'Um produto esta concentrando resultado.',
          whyItMatters: 'Produto campeao sem margem pode gerar faturamento e pouco lucro.',
          recommendedAction: 'Compare preco de venda, custo do produto e taxa de entrega antes de impulsionar.',
          total: topProduct[1].total,
          count: topProduct[1].count,
        },
      });
    }

    if (expenseTotal > 0) {
      const expenseShare = total > 0 ? (expenseTotal / total) * 100 : null;
      insights.push({
        type: expenseShare !== null && expenseShare > 70 ? 'risk' : 'attention',
        title: 'Gasto crescendo sobre a receita',
        description:
          expenseShare === null
            ? `Atenção: existem despesas registradas no periodo. Revise se elas estao ligadas a vendas reais.`
            : `Risco: as despesas registradas representam ${expenseShare.toFixed(1)}% da receita do periodo. Se esse peso continuar, o lucro pode sumir mesmo com faturamento alto.`,
        value: expenseShare === null ? this.money(expenseTotal) : `${expenseShare.toFixed(1)}%`,
        metadata: {
          priority: expenseShare !== null && expenseShare > 70 ? 'Risco' : 'Atenção',
          diagnosis: 'O gasto do periodo precisa ser comparado com a receita gerada.',
          whyItMatters: 'Crescer faturamento sem controlar despesa reduz caixa.',
          recommendedAction: 'Revise gastos fixos, anuncios e despesas operacionais da semana.',
          expenseTotal,
          revenue: total,
        },
      });
    }

    const growth = await this.weeklyGrowth(companyId, start, end, total);
    if (growth) {
      insights.push({
        type: growth.percent >= 0 ? 'growth' : 'risk',
        title: growth.percent >= 0 ? 'Semana em crescimento' : 'Queda frente ao periodo anterior',
        description:
          growth.percent >= 0
            ? `Crescimento: a receita subiu ${growth.percent.toFixed(1)}% contra o periodo anterior. Proteja o que funcionou antes de abrir novas frentes.`
            : `Risco: a receita caiu ${Math.abs(growth.percent).toFixed(1)}% contra o periodo anterior. O foco agora e descobrir se a queda veio de demanda, estoque, preco ou atendimento.`,
        value: `${growth.percent >= 0 ? '+' : ''}${growth.percent.toFixed(1)}%`,
        metadata: {
          priority: growth.percent >= 0 ? 'Crescimento' : 'Risco',
          diagnosis: 'A receita mudou de forma relevante entre periodos.',
          whyItMatters: 'Mudanca de ritmo afeta caixa, compra de estoque e investimento em campanha.',
          recommendedAction: growth.percent >= 0
            ? 'Repita canais, ofertas e horarios que trouxeram vendas.'
            : 'Compare os dias fracos com campanhas, estoque disponivel e tempo de resposta.',
          current: total,
          previous: growth.previous,
        },
      });
    }

    insights.push({
      type: 'data_quality',
      title: 'Dados que melhoram a previsao',
      description:
        'Ação recomendada: para a Next prever vendas com mais confiança, mantenha vendas, produtos, custos e despesas atualizados. Quanto mais completo o registro, melhor a recomendacao.',
      metadata: {
        priority: 'Ação recomendada',
        diagnosis: 'As vendas existem, mas a previsao depende de mais contexto operacional.',
        whyItMatters: 'Sem custo e produto, a analise enxerga faturamento, mas nao lucro real.',
        recommendedAction: 'Atualize custos dos produtos mais vendidos e despesas dos ultimos dias.',
      },
    });

    return insights.slice(0, 6);
  }

  private emptyStateInsights(): InsightItem[] {
    return [
      {
        type: 'info',
        title: 'Dados insuficientes para previsao segura',
        description:
          'Atenção: a Next ainda precisa de vendas registradas para prever receita, margem e melhores horarios com confiança.',
        metadata: {
          priority: 'Atenção',
          diagnosis: 'Nao ha vendas no periodo selecionado.',
          whyItMatters: 'Sem vendas, qualquer numero seria chute.',
          recommendedAction: 'Adicione vendas dos ultimos dias ou conecte um canal de venda.',
        },
      },
      {
        type: 'action',
        title: 'Primeiro dado que mais ajuda',
        description:
          'Ação recomendada: comece cadastrando vendas, produto vendido, preco e custo. Com isso ja da para enxergar margem e prioridade de estoque.',
        metadata: {
          priority: 'Ação recomendada',
          diagnosis: 'O negocio precisa de dados basicos antes da analise avancada.',
          whyItMatters: 'Preco sem custo mostra faturamento, mas nao mostra lucro.',
          recommendedAction: 'Cadastre os produtos mais vendidos e seus custos reais.',
        },
      },
      {
        type: 'opportunity',
        title: 'Integrações aceleram a leitura',
        description:
          'Oportunidade: quando os canais de venda e atendimento estao conectados, a Next cruza pedidos, mensagens e produtos sem trabalho manual.',
        metadata: {
          priority: 'Oportunidade',
          diagnosis: 'A empresa pode reduzir trabalho manual com dados conectados.',
          whyItMatters: 'Dados em tempo real liberam alertas de estoque, margem e atendimento.',
          recommendedAction: 'Se estiver no Premium, conecte WhatsApp, Instagram ou Mercado Livre.',
        },
      },
    ];
  }

  private findPeakHour(sales: Array<{ occurredAt: Date; amount: unknown }>) {
    const byHour = new Map<number, number>();
    for (const sale of sales) {
      const hour = new Date(sale.occurredAt).getHours();
      byHour.set(hour, (byHour.get(hour) || 0) + Number(sale.amount || 0));
    }
    const [hour, revenue] = [...byHour.entries()].sort((a, b) => b[1] - a[1])[0] || [];
    if (hour === undefined) return null;
    return { hour, revenue };
  }

  private async weeklyGrowth(companyId: string, start: Date, end: Date, currentTotal: number) {
    const durationMs = end.getTime() - start.getTime();
    if (durationMs <= 0) return null;
    const previousEnd = new Date(start.getTime() - 1);
    const previousStart = new Date(previousEnd.getTime() - durationMs);
    const previous = await this.salesService.getAggregatesByCompanyAndPeriod(companyId, previousStart, previousEnd);
    if (previous.total <= 0) return null;
    return {
      previous: previous.total,
      percent: ((currentTotal - previous.total) / previous.total) * 100,
    };
  }

  private money(value: number) {
    return value.toLocaleString('pt-BR', {
      style: 'currency',
      currency: 'BRL',
    });
  }
}
