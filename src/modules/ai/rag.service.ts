import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SalesService } from '../sales/sales.service';
import { InsightsService } from '../insights/insights.service';

/**
 * Retrieval-Augmented Generation: busca dados relevantes por company_id
 * e monta contexto rico para a LLM.
 */
@Injectable()
export class RagService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly salesService: SalesService,
    private readonly insightsService: InsightsService,
  ) {}

  async buildContext(companyId: string, query: string): Promise<string> {
    const normalizedCompanyId = companyId?.trim();
    if (!normalizedCompanyId) {
      throw new BadRequestException('companyId nao informado');
    }

    const end = new Date();
    const start = new Date();
    start.setMonth(start.getMonth() - 3);
    const monthStart = new Date(end.getFullYear(), end.getMonth(), 1);

    const [
      company,
      aggregates,
      insights,
      products,
      confirmedImports,
      mercadoLivreToken,
      mercadoLivreMonthOrders,
      mercadoLivreMonthRevenue,
      mercadoLivrePendingQuestions,
      mercadoLivreOrderItems,
    ] = await Promise.all([
      this.prisma.company.findUnique({
        where: { id: normalizedCompanyId },
        select: {
          id: true,
          name: true,
          currency: true,
          timezone: true,
        },
      }),
      this.salesService.getAggregatesByCompanyAndPeriod(normalizedCompanyId, start, end),
      this.insightsService.getInsights(normalizedCompanyId, start, end),
      this.prisma.product.findMany({
        where: { companyId: normalizedCompanyId },
        select: { name: true, price: true, cost: true, tax: true, shipping: true, sku: true },
        take: 50,
      }),
      this.prisma.intelligentImport.findMany({
        where: {
          companyId: normalizedCompanyId,
          status: 'CONFIRMED',
        },
        select: {
          aiSummary: true,
          detectedCategory: true,
          detectedPlatform: true,
          confirmedAt: true,
          importedMetrics: {
            where: { status: 'CONFIRMED' },
            select: {
              metricKey: true,
              label: true,
              value: true,
              unit: true,
              source: true,
            },
            take: 10,
          },
        },
        orderBy: { confirmedAt: 'desc' },
        take: 5,
      }),
      this.prisma.mercadoLivreOAuthToken.findUnique({
        where: { companyId: normalizedCompanyId },
        select: { status: true, mlUserId: true, nickname: true, lastSyncAt: true },
      }),
      this.prisma.mercadoLivreOrder.count({
        where: {
          companyId: normalizedCompanyId,
          dateCreated: { gte: monthStart, lte: end },
          status: { in: ['paid', 'confirmed', 'closed'] },
        },
      }),
      this.prisma.mercadoLivreOrder.aggregate({
        where: {
          companyId: normalizedCompanyId,
          dateCreated: { gte: monthStart, lte: end },
          status: { in: ['paid', 'confirmed', 'closed'] },
        },
        _sum: { paidAmount: true, totalAmount: true },
      }),
      this.prisma.mercadoLivreQuestion.count({
        where: {
          companyId: normalizedCompanyId,
          OR: [{ answer: null }, { status: { in: ['UNANSWERED', 'unanswered', 'pending'] } }],
        },
      }),
      this.prisma.mercadoLivreOrderItem.findMany({
        where: {
          companyId: normalizedCompanyId,
          order: {
            dateCreated: { gte: monthStart, lte: end },
            status: { in: ['paid', 'confirmed', 'closed'] },
          },
        },
        select: { title: true, quantity: true, unitPrice: true },
        take: 500,
      }),
    ]);

    const parts: string[] = [];

    parts.push('## Empresa');
    parts.push(`Nome: ${company?.name ?? 'N/A'}`);
    parts.push(`Moeda: ${company?.currency ?? 'BRL'}`);
    parts.push(`Timezone: ${company?.timezone ?? 'America/Sao_Paulo'}`);

    parts.push('\n## Produtos e precos atuais');
    if (products.length > 0) {
      for (const p of products) {
        parts.push(
          `- Produto: ${p.name} (SKU: ${p.sku || 'N/A'}) | Venda: ${p.price} | Custo: ${p.cost || 0} | Impostos: ${p.tax || 0} | Frete: ${p.shipping || 0}`,
        );
      }
    } else {
      parts.push('Nenhum produto cadastrado atualmente.');
    }

    parts.push('\n## Resumo de vendas (ultimos 3 meses)');
    parts.push(`Total de vendas: ${aggregates.sales.length}`);
    parts.push(`Faturamento total: ${aggregates.total.toFixed(2)}`);
    if (Object.keys(aggregates.byProduct).length > 0) {
      parts.push('Por produto:');
      for (const [name, data] of Object.entries(
        aggregates.byProduct as Record<string, { count: number; total: number }>,
      )) {
        parts.push(`  - ${name}: ${data.count} un., R$ ${data.total.toFixed(2)}`);
      }
    }

    const mlTopProducts = this.buildMercadoLivreTopProducts(mercadoLivreOrderItems);
    const mlPaidRevenue =
      Number(mercadoLivreMonthRevenue._sum.paidAmount ?? 0) ||
      Number(mercadoLivreMonthRevenue._sum.totalAmount ?? 0);
    parts.push('\n## Mercado Livre');
    parts.push(
      `Status: ${
        mercadoLivreToken?.status === 'connected'
          ? `conectado (seller ${mercadoLivreToken.mlUserId}${mercadoLivreToken.nickname ? ` / ${mercadoLivreToken.nickname}` : ''})`
          : 'nao conectado'
      }`,
    );
    parts.push(`Ultima sincronizacao: ${mercadoLivreToken?.lastSyncAt?.toISOString() ?? 'N/A'}`);
    parts.push(`Pedidos pagos/confirmados no mes: ${mercadoLivreMonthOrders}`);
    parts.push(`Faturamento Mercado Livre no mes: R$ ${mlPaidRevenue.toFixed(2)}`);
    parts.push(`Perguntas pendentes no Mercado Livre: ${mercadoLivrePendingQuestions}`);
    if (mlTopProducts.length > 0) {
      parts.push('Top produtos Mercado Livre no mes:');
      mlTopProducts.forEach((item) => {
        parts.push(`  - ${item.title}: ${item.quantity} un., R$ ${item.revenue.toFixed(2)}`);
      });
    } else {
      parts.push('Sem produtos vendidos pelo Mercado Livre no mes.');
    }

    parts.push('\n## Insights estrategicos');
    for (const i of insights) {
      parts.push(`- ${i.title}: ${i.description}`);
      if (i.value != null) parts.push(`  Valor: ${i.value}`);
    }

    parts.push('\n## Importacoes inteligentes confirmadas');
    if (confirmedImports.length > 0) {
      confirmedImports.forEach((item, index) => {
        parts.push(
          `- Importacao ${index + 1}: categoria ${item.detectedCategory || 'UNKNOWN'} | plataforma ${item.detectedPlatform || 'unknown'} | resumo: ${item.aiSummary || 'Sem resumo'}`,
        );
        item.importedMetrics.forEach((metric) => {
          parts.push(
            `  - ${metric.label} (${metric.metricKey}) = ${JSON.stringify(metric.value)} | unidade ${metric.unit} | origem ${metric.source}`,
          );
        });
      });
    } else {
      parts.push('Nenhuma importacao inteligente confirmada no momento.');
    }

    parts.push('\n---');
    parts.push(`Pergunta do usuario: ${query}`);

    return parts.join('\n');
  }

  private buildMercadoLivreTopProducts(items: Array<{ title: string; quantity: number; unitPrice: unknown }>) {
    const totals = new Map<string, { quantity: number; revenue: number }>();
    for (const item of items) {
      const title = item.title || 'Produto Mercado Livre';
      const current = totals.get(title) || { quantity: 0, revenue: 0 };
      current.quantity += item.quantity || 0;
      current.revenue += Number(item.unitPrice ?? 0) * (item.quantity || 0);
      totals.set(title, current);
    }
    return Array.from(totals.entries())
      .map(([title, data]) => ({ title, quantity: data.quantity, revenue: data.revenue }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 5);
  }
}
