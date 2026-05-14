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
        title: 'Dados insuficientes para previsao segura',
        summary: 'A Next ainda precisa de vendas registradas para prever receita, margem e produtos fortes com confianca.',
        impact: 'Sem vendas, qualquer numero seria chute.',
        recommendation: 'Adicione vendas, produtos e custos dos ultimos dias para liberar analises melhores.',
        priority: 'medium',
        source: 'backend_metrics',
      });
      insights.push({
        type: 'first_action',
        title: 'Primeiro passo para enxergar lucro',
        summary: 'O dado mais importante agora e simples: produto vendido, preco de venda e custo. Isso ja mostra se a empresa esta faturando com margem real.',
        recommendation: 'Comece pelos produtos que mais saem ou pelos pedidos mais recentes.',
        priority: 'medium',
        source: 'backend_metrics',
      });
    } else {
      insights.push({
        type: 'financial_summary',
        title: 'Resultado do periodo em linguagem de negocio',
        summary: `A empresa faturou R$ ${metrics.revenue.toFixed(2)} e teve lucro estimado de R$ ${metrics.profit.toFixed(2)} no periodo analisado.`,
        impact: metrics.margin === null ? null : `A margem estimada ficou em ${metrics.margin.toFixed(2)}%.`,
        recommendation:
          metrics.margin !== null && metrics.margin < 15
            ? 'Revise custo, preco e taxas antes de aumentar investimento em campanhas.'
            : 'Use os produtos de melhor resultado como base para campanhas, recompra e atendimento ativo.',
        priority: metrics.margin !== null && metrics.margin < 15 ? 'high' : 'medium',
        source: 'backend_metrics',
      });
    }

    const bestProduct = metrics.salesByProduct[0];
    if (bestProduct) {
      insights.push({
        type: 'product_attention',
        title: 'Produto que puxa faturamento',
        summary: `${bestProduct.productName} gerou R$ ${bestProduct.revenue.toFixed(2)} no periodo. Antes de investir mais nele, confirme se a margem acompanha o volume.`,
        impact: 'Produto campeao sem margem pode gerar caixa curto mesmo vendendo bem.',
        recommendation: 'Compare preco de venda, custo, frete e taxas. Se a margem estiver boa, crie combo, recompra ou upsell.',
        priority: 'medium',
        source: 'backend_metrics',
      });
    }

    if (metrics.operationalWaste !== null && metrics.operationalWaste > 30) {
      insights.push({
        type: 'cost_attention',
        title: 'Gasto crescendo mais rapido que receita',
        summary: `Os custos operacionais equivalem a ${metrics.operationalWaste.toFixed(2)}% da receita. Esse peso pode reduzir lucro mesmo quando o faturamento parece bom.`,
        impact: 'Custo alto tira folego de caixa e limita investimento em crescimento.',
        recommendation: 'Revise gastos fixos, anuncios e despesas operacionais da semana. Corte primeiro o que nao traz venda ou eficiencia.',
        priority: 'high',
        source: 'backend_metrics',
      });
    }

    if (metrics.salesCount > 0 && metrics.salesByProduct.length < 3) {
      insights.push({
        type: 'data_depth',
        title: 'Mais detalhes aumentam a qualidade da analise',
        summary: 'Ja existem vendas, mas poucos produtos aparecem na leitura. Quanto mais completo o registro, mais precisa fica a recomendacao de estoque, margem e oferta.',
        recommendation: 'Mantenha nome do produto, preco, custo e canal de venda em cada pedido.',
        priority: 'low',
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
