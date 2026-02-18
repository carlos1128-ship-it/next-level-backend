import { Injectable } from '@nestjs/common';
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
    const end = new Date();
    const start = new Date();
    start.setMonth(start.getMonth() - 3);

    const [company, aggregates, insights] = await Promise.all([
      this.prisma.company.findUnique({ where: { id: companyId } }),
      this.salesService.getAggregatesByCompanyAndPeriod(companyId, start, end),
      this.insightsService.getInsights(companyId, start, end),
    ]);

    const parts: string[] = [];

    parts.push('## Empresa');
    parts.push(`Nome: ${company?.name ?? 'N/A'}`);
    parts.push(`Moeda: ${company?.currency ?? 'BRL'}`);
    parts.push(`Timezone: ${company?.timezone ?? 'America/Sao_Paulo'}`);

    parts.push('\n## Resumo de vendas (últimos 3 meses)');
    parts.push(`Total de vendas: ${aggregates.sales.length}`);
    parts.push(`Faturamento total: ${aggregates.total.toFixed(2)}`);
    if (Object.keys(aggregates.byProduct).length > 0) {
      parts.push('Por produto:');
      for (const [name, data] of Object.entries(aggregates.byProduct as Record<string, { count: number; total: number }>)) {
        parts.push(`  - ${name}: ${data.count} un., R$ ${data.total.toFixed(2)}`);
      }
    }

    parts.push('\n## Insights estratégicos');
    for (const i of insights) {
      parts.push(`- ${i.title}: ${i.description}`);
      if (i.value != null) parts.push(`  Valor: ${i.value}`);
    }

    parts.push('\n---');
    parts.push(`Pergunta do usuário: ${query}`);

    return parts.join('\n');
  }
}
