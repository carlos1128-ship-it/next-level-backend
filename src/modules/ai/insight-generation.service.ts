import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { BusinessMetricSnapshot, AiBusinessCard } from './business-intelligence.types';

@Injectable()
export class InsightGenerationService {
  constructor(private readonly prisma: PrismaService) {}

  buildInsights(metrics: BusinessMetricSnapshot): AiBusinessCard[] {
    const insights: AiBusinessCard[] = [];

    if (metrics.salesCount === 0) {
      insights.push({
        type: 'missing_sales_data',
        title: 'Ainda faltam vendas no periodo',
        summary: 'Nao ha vendas suficientes para diagnosticar crescimento, ticket ou produtos vencedores.',
        recommendation: 'Cadastre vendas ou conecte uma integracao de pedidos para liberar analises reais.',
        priority: 'medium',
        source: 'backend_metrics',
      });
    } else {
      insights.push({
        type: 'financial_summary',
        title: 'Resumo inteligente do periodo',
        summary: `A empresa faturou R$ ${metrics.revenue.toFixed(2)} com lucro estimado de R$ ${metrics.profit.toFixed(2)}.`,
        impact: metrics.margin === null ? null : `Margem atual: ${metrics.margin.toFixed(2)}%.`,
        recommendation:
          metrics.margin !== null && metrics.margin < 15
            ? 'Priorize revisao de custos e precos antes de aumentar investimento em campanhas.'
            : 'Use os produtos de melhor resultado como base para campanhas e follow-ups.',
        priority: metrics.margin !== null && metrics.margin < 15 ? 'high' : 'medium',
        source: 'backend_metrics',
      });
    }

    const bestProduct = metrics.salesByProduct[0];
    if (bestProduct) {
      insights.push({
        type: 'product_attention',
        title: `Produto em destaque: ${bestProduct.productName}`,
        summary: `${bestProduct.productName} gerou R$ ${bestProduct.revenue.toFixed(2)} no periodo.`,
        recommendation: 'Crie uma acao de recompra, combo ou upsell para clientes com interesse nesse produto.',
        priority: 'medium',
        source: 'backend_metrics',
      });
    }

    if (metrics.operationalWaste !== null && metrics.operationalWaste > 30) {
      insights.push({
        type: 'cost_attention',
        title: 'Custo operacional pressionando resultado',
        summary: `Custos operacionais equivalem a ${metrics.operationalWaste.toFixed(2)}% da receita.`,
        recommendation: 'Revise categorias de custo recorrentes e corte gastos sem impacto direto em vendas.',
        priority: 'high',
        source: 'backend_metrics',
      });
    }

    return insights;
  }

  async persistInsights(companyId: string, insights: AiBusinessCard[]) {
    for (const insight of insights) {
      await this.prisma.aiInsight.create({
        data: {
          companyId,
          type: insight.type,
          title: insight.title,
          summary: insight.summary,
          impact: insight.impact,
          recommendation: insight.recommendation,
          priority: insight.priority,
          source: insight.source,
        },
      });
    }
  }
}
