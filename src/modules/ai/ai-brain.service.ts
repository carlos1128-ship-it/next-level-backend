import { Injectable } from '@nestjs/common';
import { BusinessContextService } from './business-context.service';
import { InsightGenerationService } from './insight-generation.service';
import { AiAlertService } from './ai-alert.service';
import { AiRecommendationService } from './ai-recommendation.service';
import { BusinessMemoryService } from './business-memory.service';
import { AiBusinessCard, AiDashboardIntelligence } from './business-intelligence.types';

export const NEXT_LEVEL_AI_SYSTEM_PROMPT = [
  'You are the official intelligence layer of NEXT LEVEL AI.',
  'NEXT LEVEL AI is not a chatbot.',
  'NEXT LEVEL AI is a business intelligence, automation, management, sales, support, analytics and Big Data platform for companies.',
  'Your role is to transform business data into practical decisions.',
  'You must never invent numbers, sales, customers, costs, products, metrics or results.',
  'Always distinguish real data, estimate, hypothesis and recommendation.',
  'The backend is the source of truth for calculations.',
  'When data is insufficient, say that the data is insufficient and explain what data is missing.',
  'Every answer must help increase revenue, reduce costs, improve margin, improve support, detect risks or identify opportunities.',
].join('\n');

@Injectable()
export class AiBrainService {
  constructor(
    private readonly businessContext: BusinessContextService,
    private readonly insightGeneration: InsightGenerationService,
    private readonly alertService: AiAlertService,
    private readonly recommendationService: AiRecommendationService,
    private readonly memoryService: BusinessMemoryService,
  ) {}

  async generateDashboardInsights(companyId: string, period = '30d'): Promise<AiDashboardIntelligence> {
    const context = await this.businessContext.buildCompanyContext(companyId, { period });
    const insights = this.insightGeneration.buildInsights(context.metrics);
    await this.insightGeneration.persistInsights(companyId, insights);
    const alerts = await this.alertService.generateMetricAlerts(companyId, context.metrics);
    const recommendations = await this.recommendationService.generateRecommendations(companyId, context.metrics);
    await this.memoryService.remember(
      companyId,
      `last_dashboard_diagnosis:${context.metrics.period.key}`,
      insights[0]?.summary || 'Dados insuficientes para diagnostico automatico.',
      'dashboard',
      0.9,
      { period: context.metrics.period, missingData: context.missingData },
    );

    return {
      period: context.metrics.period,
      mainInsight: insights[0] || this.insufficientDataCard(context.missingData),
      mainRisk: this.riskCard(alerts[0]),
      growthOpportunity: this.opportunityCard(context.metrics),
      recommendedAction: this.recommendationCard(recommendations[0]),
      productAttention: insights.find((item) => item.type === 'product_attention') || null,
      customerAttention: this.customerAttentionCard(context.metrics.inactiveCustomers),
      costAttention: insights.find((item) => item.type === 'cost_attention') || null,
      whatsappSignal: this.whatsappSignalCard(context.recentWhatsappSignals),
      nextBestActions: recommendations.slice(0, 3).map((item) => this.recommendationCard(item)).filter((item): item is AiBusinessCard => Boolean(item)),
      missingData: context.missingData,
      generatedFrom: 'backend_metrics',
    };
  }

  async generateBusinessDiagnosis(companyId: string, period = '30d') {
    const dashboard = await this.generateDashboardInsights(companyId, period);
    return {
      systemPrompt: NEXT_LEVEL_AI_SYSTEM_PROMPT,
      diagnosis: dashboard.mainInsight,
      risks: dashboard.mainRisk ? [dashboard.mainRisk] : [],
      opportunities: dashboard.growthOpportunity ? [dashboard.growthOpportunity] : [],
      nextBestActions: dashboard.nextBestActions,
      missingData: dashboard.missingData,
      generatedFrom: dashboard.generatedFrom,
    };
  }

  async generateFinancialInsights(companyId: string, period = '30d') {
    const context = await this.businessContext.buildCompanyContext(companyId, { period, includeProducts: false, includeCustomers: false });
    return {
      period: context.metrics.period,
      revenueSummary: `Faturamento real do periodo: R$ ${context.metrics.revenue.toFixed(2)}.`,
      costSummary: `Custos registrados no periodo: R$ ${context.metrics.costs.toFixed(2)}.`,
      profitSummary: `Lucro estimado pelo backend: R$ ${context.metrics.profit.toFixed(2)}.`,
      marginInterpretation:
        context.metrics.margin === null
          ? 'Dados insuficientes para margem.'
          : `Margem calculada: ${context.metrics.margin.toFixed(2)}%.`,
      costRisk: context.metrics.risks.includes('cost_pressure') || context.metrics.risks.includes('operational_waste'),
      recommendedAction:
        context.metrics.profit < 0
          ? 'Reduzir custos e revisar precos antes de escalar vendas.'
          : 'Monitorar custos recorrentes e priorizar produtos com maior margem.',
      missingData: context.missingData,
    };
  }

  async generateProductInsights(companyId: string, period = '30d') {
    const context = await this.businessContext.buildCompanyContext(companyId, { period, includeCustomers: false });
    return {
      period: context.metrics.period,
      salesByProduct: context.metrics.salesByProduct,
      profitByProduct: context.metrics.profitByProduct,
      productAttention: this.opportunityCard(context.metrics),
      missingData: context.missingData,
    };
  }

  async generateCustomerInsights(companyId: string, period = '30d') {
    const context = await this.businessContext.buildCompanyContext(companyId, { period, includeProducts: false });
    return {
      period: context.metrics.period,
      customerCount: context.metrics.customerCount,
      inactiveCustomers: context.metrics.inactiveCustomers,
      customerAttention: this.customerAttentionCard(context.metrics.inactiveCustomers),
      recentSignals: context.recentWhatsappSignals,
      missingData: context.missingData,
    };
  }

  async generateOperationalInsights(companyId: string, period = '30d') {
    const context = await this.businessContext.buildCompanyContext(companyId, { period, includeCustomers: false });
    return {
      period: context.metrics.period,
      operationalWaste: context.metrics.operationalWaste,
      peakHours: context.metrics.peakHours,
      risks: context.metrics.risks,
      opportunities: context.metrics.opportunities,
      missingData: context.missingData,
    };
  }

  async answerBusinessQuestion(companyId: string, question: string, period = '30d') {
    const context = await this.businessContext.buildCompanyContext(companyId, { period });
    return {
      question,
      answer: this.answerFromContext(question, context.metrics),
      factsUsed: {
        revenue: context.metrics.revenue,
        costs: context.metrics.costs,
        profit: context.metrics.profit,
        margin: context.metrics.margin,
        salesCount: context.metrics.salesCount,
      },
      missingData: context.missingData,
    };
  }

  async generateExecutiveReport(companyId: string, period = '30d') {
    const diagnosis = await this.generateBusinessDiagnosis(companyId, period);
    const financial = await this.generateFinancialInsights(companyId, period);
    const products = await this.generateProductInsights(companyId, period);
    const customers = await this.generateCustomerInsights(companyId, period);
    return {
      executiveSummary: diagnosis.diagnosis,
      financial,
      products,
      customers,
      mainRisk: diagnosis.risks[0] || null,
      mainOpportunity: diagnosis.opportunities[0] || null,
      recommendedActions: diagnosis.nextBestActions,
      missingData: diagnosis.missingData,
    };
  }

  async generateNextBestActions(companyId: string, period = '30d') {
    return (await this.generateDashboardInsights(companyId, period)).nextBestActions;
  }

  private insufficientDataCard(missingData: string[]): AiBusinessCard {
    return {
      type: 'insufficient_data',
      title: 'Dados insuficientes',
      summary: `Faltam dados para um diagnostico robusto: ${missingData.join(', ') || 'historico operacional'}.`,
      recommendation: 'Cadastre dados reais ou conecte uma integracao antes de tomar decisoes criticas.',
      priority: 'medium',
      source: 'backend_metrics',
    };
  }

  private riskCard(alert?: { type: string; title: string; message: string; recommendation: string; severity: string } | null): AiBusinessCard | null {
    if (!alert) return null;
    return {
      type: alert.type,
      title: alert.title,
      summary: alert.message,
      recommendation: alert.recommendation,
      priority: alert.severity === 'high' ? 'high' : 'medium',
      source: 'backend_metrics',
    };
  }

  private recommendationCard(item?: { category: string; title: string; description: string; expectedImpact: string; actionType: string } | null): AiBusinessCard | null {
    if (!item) return null;
    return {
      type: item.actionType,
      title: item.title,
      summary: item.description,
      impact: item.expectedImpact,
      recommendation: item.description,
      priority: 'medium',
      source: 'backend_metrics',
    };
  }

  private opportunityCard(metrics: { opportunities: string[]; salesByProduct: Array<{ productName: string; revenue: number }> }): AiBusinessCard | null {
    const bestProduct = metrics.salesByProduct[0];
    if (!bestProduct) return null;
    return {
      type: 'CAMPAIGN_OPPORTUNITY',
      title: `Oportunidade em ${bestProduct.productName}`,
      summary: `${bestProduct.productName} concentra demanda real no periodo.`,
      impact: `Receita associada: R$ ${bestProduct.revenue.toFixed(2)}.`,
      recommendation: 'Transforme esse sinal em campanha, combo ou follow-up comercial.',
      priority: 'medium',
      source: 'backend_metrics',
    };
  }

  private customerAttentionCard(inactiveCustomers: number): AiBusinessCard | null {
    if (inactiveCustomers <= 0) return null;
    return {
      type: 'CUSTOMER_RECOVERY_OPPORTUNITY',
      title: 'Base de clientes pede reativacao',
      summary: `${inactiveCustomers} cliente(s) podem ser trabalhados em recuperacao.`,
      recommendation: 'Crie uma lista de reativacao com oferta simples e mensagem curta no WhatsApp.',
      priority: 'medium',
      source: 'backend_metrics',
    };
  }

  private whatsappSignalCard(signals: Array<Record<string, unknown>>): AiBusinessCard | null {
    const signal = signals[0];
    if (!signal) return null;
    return {
      type: String(signal.signalType || 'WHATSAPP_SIGNAL'),
      title: 'Sinal recente do WhatsApp',
      summary: String(signal.description || 'Nova conversa registrada como sinal de negocio.'),
      recommendation: 'Use esse sinal para ajustar atendimento, follow-up ou oferta.',
      priority: 'medium',
      source: 'whatsapp',
    };
  }

  private answerFromContext(question: string, metrics: { revenue: number; costs: number; profit: number; margin: number | null; salesCount: number }) {
    const lower = question.toLowerCase();
    if (lower.includes('lucro')) return `Lucro calculado pelo backend: R$ ${metrics.profit.toFixed(2)}.`;
    if (lower.includes('fatur')) return `Faturamento real do periodo: R$ ${metrics.revenue.toFixed(2)}.`;
    if (lower.includes('custo')) return `Custos registrados no periodo: R$ ${metrics.costs.toFixed(2)}.`;
    if (lower.includes('margem')) return metrics.margin === null ? 'Dados insuficientes para calcular margem.' : `Margem calculada: ${metrics.margin.toFixed(2)}%.`;
    return `Com os dados atuais, a empresa teve ${metrics.salesCount} venda(s), R$ ${metrics.revenue.toFixed(2)} de receita e R$ ${metrics.profit.toFixed(2)} de lucro estimado.`;
  }
}
