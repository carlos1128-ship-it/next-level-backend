import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AnalyticsEngineService } from './analytics-engine.service';
import { BusinessContext } from './business-intelligence.types';

type ContextOptions = {
  period?: string;
  includeSales?: boolean;
  includeCustomers?: boolean;
  includeProducts?: boolean;
  includeCosts?: boolean;
  includeWhatsApp?: boolean;
  includeMemory?: boolean;
};

@Injectable()
export class BusinessContextService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly analyticsEngine: AnalyticsEngineService,
  ) {}

  async buildCompanyContext(companyId: string, options: ContextOptions = {}): Promise<BusinessContext> {
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { id: true, name: true, sector: true, segment: true, currency: true },
    });

    if (!company) {
      throw new BadRequestException('Empresa nao encontrada');
    }

    const [
      profile,
      metrics,
      recentEvents,
      recentInsights,
      recentAlerts,
      recentRecommendations,
      recentWhatsappSignals,
      memory,
    ] = await Promise.all([
      this.prisma.companyProfile.findUnique({ where: { companyId } }),
      this.analyticsEngine.calculateMetrics(companyId, options.period),
      this.prisma.businessEvent.findMany({
        where: { companyId },
        orderBy: { occurredAt: 'desc' },
        take: 20,
      }),
      this.prisma.aiInsight.findMany({
        where: { companyId },
        orderBy: { createdAt: 'desc' },
        take: 10,
      }),
      this.prisma.aiAlert.findMany({
        where: { companyId },
        orderBy: { createdAt: 'desc' },
        take: 10,
      }),
      this.prisma.aiRecommendation.findMany({
        where: { companyId },
        orderBy: { createdAt: 'desc' },
        take: 10,
      }),
      options.includeWhatsApp === false
        ? Promise.resolve([])
        : this.prisma.customerSignal.findMany({
            where: { companyId, source: { in: ['whatsapp', 'whatsapp_agent'] } },
            orderBy: { createdAt: 'desc' },
            take: 10,
          }),
      options.includeMemory === false
        ? Promise.resolve([])
        : this.prisma.businessMemory.findMany({
            where: { companyId },
            orderBy: { updatedAt: 'desc' },
            take: 20,
          }),
    ]);

    const missingData = this.detectMissingData(metrics, {
      includeSales: options.includeSales,
      includeCustomers: options.includeCustomers,
      includeProducts: options.includeProducts,
      includeCosts: options.includeCosts,
      includeWhatsApp: options.includeWhatsApp,
    });

    return {
      company,
      profile: profile ? (profile as unknown as Record<string, unknown>) : null,
      metrics,
      recentEvents: recentEvents as unknown as Array<Record<string, unknown>>,
      recentInsights: recentInsights as unknown as Array<Record<string, unknown>>,
      recentAlerts: recentAlerts as unknown as Array<Record<string, unknown>>,
      recentRecommendations: recentRecommendations as unknown as Array<Record<string, unknown>>,
      recentWhatsappSignals: recentWhatsappSignals as unknown as Array<Record<string, unknown>>,
      memory: memory as unknown as Array<Record<string, unknown>>,
      missingData,
      availableData: this.detectAvailableData(metrics, recentWhatsappSignals.length, memory.length),
    };
  }

  private detectMissingData(
    metrics: BusinessContext['metrics'],
    options: {
      includeSales?: boolean;
      includeCustomers?: boolean;
      includeProducts?: boolean;
      includeCosts?: boolean;
      includeWhatsApp?: boolean;
    },
  ) {
    const missing: string[] = [];
    if (options.includeSales !== false && metrics.salesCount === 0) missing.push('vendas do periodo');
    if (options.includeProducts !== false && metrics.productCount === 0) missing.push('catalogo de produtos');
    if (options.includeCustomers !== false && metrics.customerCount === 0) missing.push('base de clientes');
    if (options.includeCosts !== false && metrics.costs === 0) missing.push('custos operacionais');
    if (options.includeWhatsApp !== false && metrics.salesCount === 0) missing.push('sinais de conversas WhatsApp');
    return missing;
  }

  private detectAvailableData(metrics: BusinessContext['metrics'], whatsappSignals: number, memoryItems: number) {
    const available: string[] = [];
    if (metrics.salesCount > 0) available.push('vendas');
    if (metrics.productCount > 0) available.push('produtos');
    if (metrics.customerCount > 0) available.push('clientes');
    if (metrics.costs > 0) available.push('custos');
    if (whatsappSignals > 0) available.push('sinais de WhatsApp');
    if (memoryItems > 0) available.push('memoria empresarial');
    return available;
  }
}
