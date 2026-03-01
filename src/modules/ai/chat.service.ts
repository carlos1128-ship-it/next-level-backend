import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiChatRole, FinancialTransactionType } from '@prisma/client';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { DashboardService } from '../dashboard/dashboard.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ChatRequestDto } from './dto/chat-request.dto';
import { RagService } from './rag.service';

export interface ChatReply {
  response: string;
  source: 'gemini' | 'local';
}

type DetailLevel = 'low' | 'medium' | 'high';
type SegmentKey =
  | 'Comercio'
  | 'Industria'
  | 'Servicos'
  | 'Tech'
  | 'Agronegocio'
  | 'Educacao'
  | 'Geral';

interface CompanyProfile {
  name: string;
  businessType: string;
  size: string;
  segment: SegmentKey;
  yearsInOperation: string;
}

interface FinancialSnapshot {
  income: number;
  expense: number;
  profit: number;
  growthPercent: number;
  projectedCashflow: number;
}

interface MonthlyNet {
  key: string;
  net: number;
}

const SYSTEM_PROMPT = [
  'Voce e o Consultor Empresarial Oficial da Next Level.',
  'Voce auxilia empresas de qualquer segmento: comercio, industria, servicos, tecnologia, agronegocio, educacao e outros.',
  'Voce deve:',
  '- Fornecer analises estrategicas claras',
  '- Adaptar a linguagem ao porte da empresa',
  '- Evitar respostas genericas',
  '- Ser direto e articulado',
  '- Trazer recomendacoes praticas',
  '- Identificar riscos ocultos',
  '- Sugerir melhorias operacionais e financeiras',
  '- Agir como um CFO e estrategista de negocios',
  'Sempre responda com:',
  '1. Diagnostico',
  '2. Analise',
  '3. Recomendacoes praticas',
  '4. Proximos passos',
].join('\n');

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);
  private readonly genAI: GoogleGenerativeAI | null;
  private readonly model: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly dashboardService: DashboardService,
    private readonly ragService: RagService,
  ) {
    const apiKey = this.configService.get<string>('GEMINI_API_KEY');
    this.genAI = apiKey ? new GoogleGenerativeAI(apiKey) : null;
    this.model = this.configService.get<string>('GEMINI_MODEL') || 'gemini-2.5-flash';
  }

  async chat(userId: string, dto: ChatRequestDto): Promise<ChatReply> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, companyId: true, detailLevel: true },
    });
    if (!user) {
      throw new BadRequestException('Usuario nao encontrado');
    }

    const companyId = dto.companyId?.trim();
    if (!companyId) {
      throw new BadRequestException('companyId nao informado');
    }

    let company = await this.prisma.company.findFirst({
      where: {
        id: companyId,
        OR: [{ userId: user.id }, { users: { some: { id: user.id } } }],
      },
      select: { id: true, name: true, currency: true, createdAt: true },
    });

    // Fallback for stale companyId in client state.
    if (!company && user.companyId) {
      company = await this.prisma.company.findFirst({
        where: {
          id: user.companyId,
          OR: [{ userId: user.id }, { users: { some: { id: user.id } } }],
        },
        select: { id: true, name: true, currency: true, createdAt: true },
      });
    }

    if (!company) {
      company = await this.prisma.company.findFirst({
        where: {
          OR: [{ userId: user.id }, { users: { some: { id: user.id } } }],
        },
        orderBy: { createdAt: 'asc' },
        select: { id: true, name: true, currency: true, createdAt: true },
      });
    }

    if (!company?.id) {
      throw new BadRequestException(
        'Empresa nao encontrada para o companyId informado',
      );
    }

    const detailLevel = this.normalizeDetailLevel(user.detailLevel);

    const startDate = new Date();
    startDate.setMonth(startDate.getMonth() - 5);

    const [dashboard, recentTransactions, history, financialTransactions] = await Promise.all([
      this.dashboardService.getDashboard(company.id),
      this.prisma.financialTransaction.findMany({
        where: { companyId: company.id },
        orderBy: { date: 'desc' },
        take: 5,
        select: { type: true, amount: true, description: true, category: true, date: true },
      }),
      this.prisma.aiChatMessage.findMany({
        where: { companyId: company.id },
        orderBy: { createdAt: 'desc' },
        take: 15,
        select: { role: true, content: true, createdAt: true },
      }),
      this.prisma.financialTransaction.findMany({
        where: {
          companyId: company.id,
          occurredAt: { gte: startDate },
        },
        orderBy: { occurredAt: 'asc' },
        select: { type: true, amount: true, occurredAt: true },
      }),
    ]);

    const monthlyNets = this.buildMonthlyNets(financialTransactions);
    const profile = this.buildCompanyProfile(
      company.name,
      company.createdAt,
      dashboard.totalIncome,
      dto.message,
      history,
    );
    const financialSnapshot = this.buildFinancialSnapshot(dashboard, monthlyNets);
    const historyContext = this.formatChatHistory(history);
    const focus = this.segmentFocus(profile.segment);
    const context = this.buildDynamicPrompt(
      profile,
      financialSnapshot,
      historyContext,
      dto.message,
      focus,
      detailLevel,
      company.currency ?? 'BRL',
      recentTransactions,
    );

    const reply = await this.buildReply(dto.message, context, dashboard, company.id);

    await this.prisma.$transaction([
      this.prisma.aiChatMessage.create({
        data: {
          userId: user.id,
          companyId: company.id,
          role: AiChatRole.USER,
          content: dto.message.trim(),
        },
      }),
      this.prisma.aiChatMessage.create({
        data: {
          userId: user.id,
          companyId: company.id,
          role: AiChatRole.ASSISTANT,
          content: reply.response,
        },
      }),
    ]);

    return reply;
  }

  private async buildReply(
    userMessage: string,
    context: string,
    dashboard: {
      totalIncome: number;
      totalExpense: number;
      balance: number;
      transactionsCount: number;
    },
    companyId: string,
  ): Promise<ChatReply> {
    if (!this.genAI) {
      return { response: this.buildLocalFallback(userMessage, dashboard), source: 'local' };
    }

    try {
      const model = this.genAI.getGenerativeModel({ model: this.model });
      let ragContext = '';
      try {
        ragContext = await this.ragService.buildContext(companyId, userMessage);
      } catch (error) {
        this.logger.warn(
          `Falha ao montar RAG contextual; seguindo sem RAG. Erro: ${
            error instanceof Error ? error.message : 'desconhecido'
          }`,
        );
      }

      const prompt = [SYSTEM_PROMPT, context, ragContext ? `CONTEXTO RAG:\n${ragContext}` : ''].filter(Boolean).join('\n\n');

      const response = await model.generateContent(prompt);
      const text = response.response.text()?.trim();

      if (!text) {
        return { response: this.buildLocalFallback(userMessage, dashboard), source: 'local' };
      }

      return { response: text, source: 'gemini' };
    } catch (error) {
      this.logger.warn(`Falha ao consultar Gemini; usando fallback local. Erro: ${
        error instanceof Error ? error.message : 'desconhecido'
      }`);
      return { response: this.buildLocalFallback(userMessage, dashboard), source: 'local' };
    }
  }

  private normalizeDetailLevel(value: string | null | undefined): DetailLevel {
    if (value === 'low' || value === 'high') return value;
    return 'medium';
  }

  private detailStyle(detailLevel: DetailLevel): string {
    if (detailLevel === 'low') {
      return 'Nivel de detalhe: baixo. Responda em ate 5 linhas curtas.';
    }
    if (detailLevel === 'high') {
      return 'Nivel de detalhe: alto. Responda em ate 220 palavras, com no maximo 6 bullets.';
    }
    return 'Nivel de detalhe: medio. Responda em ate 120 palavras, com no maximo 4 bullets.';
  }

  private buildCompanyProfile(
    companyName: string,
    companyCreatedAt: Date,
    totalIncome: number,
    message: string,
    history: Array<{ role: AiChatRole; content: string }>,
  ): CompanyProfile {
    const segment = this.detectSegment(companyName, message, history);
    const businessType = this.businessTypeBySegment(segment);
    const size = this.classifyCompanySize(totalIncome);
    const yearsInOperation = this.yearsInOperationFromDate(companyCreatedAt);

    return {
      name: companyName,
      businessType,
      size,
      segment,
      yearsInOperation,
    };
  }

  private buildFinancialSnapshot(
    dashboard: {
      totalIncome: number;
      totalExpense: number;
      balance: number;
    },
    monthlyNets: MonthlyNet[],
  ): FinancialSnapshot {
    const sorted = [...monthlyNets].sort((a, b) => a.key.localeCompare(b.key));
    const current = sorted.at(-1)?.net ?? 0;
    const previous = sorted.at(-2)?.net ?? 0;
    const growthPercent =
      previous === 0 ? 0 : ((current - previous) / Math.abs(previous)) * 100;

    const lastThree = sorted.slice(-3);
    const averageNet =
      lastThree.length === 0
        ? 0
        : lastThree.reduce((acc, item) => acc + item.net, 0) / lastThree.length;
    const projectedCashflow = dashboard.balance + averageNet;

    return {
      income: dashboard.totalIncome,
      expense: dashboard.totalExpense,
      profit: dashboard.balance,
      growthPercent: this.round(growthPercent),
      projectedCashflow: this.round(projectedCashflow),
    };
  }

  private buildMonthlyNets(
    transactions: Array<{
      type: FinancialTransactionType;
      amount: unknown;
      occurredAt: Date;
    }>,
  ): MonthlyNet[] {
    const monthMap = new Map<string, number>();

    for (const tx of transactions) {
      const date = new Date(tx.occurredAt);
      const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
      const amount = Number(tx.amount ?? 0);
      const signedAmount =
        tx.type === FinancialTransactionType.INCOME ? amount : -amount;

      monthMap.set(monthKey, (monthMap.get(monthKey) ?? 0) + signedAmount);
    }

    return [...monthMap.entries()].map(([key, net]) => ({
      key,
      net: this.round(net),
    }));
  }

  private buildDynamicPrompt(
    profile: CompanyProfile,
    snapshot: FinancialSnapshot,
    chatHistory: string,
    userMessage: string,
    segmentFocus: string,
    detailLevel: DetailLevel,
    currency: string,
    recentTransactions: Array<{
      type: FinancialTransactionType;
      amount: unknown;
      description: string;
      category: string | null;
      date: Date;
    }>,
  ): string {
    const symbol = currency === 'BRL' ? 'R$' : currency;

    return [
      `ESTILO DE RESPOSTA:\n${this.detailStyle(detailLevel)}`,
      'EMPRESA:',
      `Nome: ${profile.name}`,
      `Segmento: ${profile.segment}`,
      `Tipo: ${profile.businessType}`,
      `Porte: ${profile.size}`,
      `Tempo de mercado: ${profile.yearsInOperation}`,
      '',
      'RESUMO FINANCEIRO ATUAL:',
      `Receita: ${symbol} ${snapshot.income.toFixed(2)}`,
      `Despesa: ${symbol} ${snapshot.expense.toFixed(2)}`,
      `Lucro: ${symbol} ${snapshot.profit.toFixed(2)}`,
      `Crescimento: ${snapshot.growthPercent.toFixed(2)}%`,
      `Fluxo projetado: ${symbol} ${snapshot.projectedCashflow.toFixed(2)}`,
      '',
      `FOCO ESTRATEGICO POR SEGMENTO: ${segmentFocus}`,
      `ULTIMAS TRANSACOES REAIS: ${JSON.stringify(recentTransactions)}`,
      '',
      'HISTORICO DO CHAT:',
      chatHistory || 'Sem historico anterior.',
      '',
      'PERGUNTA DO USUARIO:',
      userMessage,
    ].join('\n');
  }

  private formatChatHistory(
    history: Array<{ role: AiChatRole; content: string; createdAt: Date }>,
  ): string {
    return [...history]
      .reverse()
      .map((item) => {
        const role = item.role === AiChatRole.USER ? 'user' : 'assistant';
        const when = new Date(item.createdAt).toISOString();
        return `[${when}] ${role}: ${item.content}`;
      })
      .join('\n');
  }

  private detectSegment(
    companyName: string,
    userMessage: string,
    history: Array<{ content: string }>,
  ): SegmentKey {
    const corpus = `${companyName} ${userMessage} ${history.map((item) => item.content).join(' ')}`.toLowerCase();

    if (this.hasAny(corpus, ['loja', 'varejo', 'ecommerce', 'estoque', 'giro'])) return 'Comercio';
    if (this.hasAny(corpus, ['industria', 'fabrica', 'producao', 'linha de producao'])) return 'Industria';
    if (this.hasAny(corpus, ['servico', 'agencia', 'consultoria', 'atendimento'])) return 'Servicos';
    if (this.hasAny(corpus, ['saas', 'software', 'startup', 'churn', 'ltv', 'cac'])) return 'Tech';
    if (this.hasAny(corpus, ['agro', 'fazenda', 'safra', 'plantio'])) return 'Agronegocio';
    if (this.hasAny(corpus, ['escola', 'curso', 'aluno', 'matricula', 'educacao'])) return 'Educacao';
    return 'Geral';
  }

  private segmentFocus(segment: SegmentKey): string {
    const focusMap: Record<SegmentKey, string> = {
      Comercio: 'margem, estoque e giro',
      Industria: 'custo fixo, producao e eficiencia operacional',
      Servicos: 'precificacao, capacidade e retencao de clientes',
      Tech: 'CAC, LTV, churn e eficiencia de crescimento',
      Agronegocio: 'sazonalidade, produtividade e risco climatico',
      Educacao: 'matriculas, retencao e inadimplencia',
      Geral: 'caixa, margem e produtividade comercial',
    };

    return focusMap[segment];
  }

  private businessTypeBySegment(segment: SegmentKey): string {
    const bySegment: Record<SegmentKey, string> = {
      Comercio: 'Comercio',
      Industria: 'Industria',
      Servicos: 'Servico',
      Tech: 'Tecnologia',
      Agronegocio: 'Agronegocio',
      Educacao: 'Educacao',
      Geral: 'Nao informado',
    };
    return bySegment[segment];
  }

  private classifyCompanySize(totalIncome: number): string {
    if (totalIncome <= 120000) return 'MEI';
    if (totalIncome <= 960000) return 'Pequena';
    if (totalIncome <= 4800000) return 'Media';
    return 'Grande';
  }

  private yearsInOperationFromDate(createdAt: Date): string {
    if (!createdAt) return 'Nao informado';
    const now = new Date();
    const diffMs = now.getTime() - new Date(createdAt).getTime();
    const years = Math.max(0, Math.floor(diffMs / (1000 * 60 * 60 * 24 * 365)));
    if (years === 0) return '< 1 ano';
    if (years === 1) return '1 ano';
    return `${years} anos`;
  }

  private hasAny(text: string, terms: string[]): boolean {
    return terms.some((term) => text.includes(term));
  }

  private round(value: number): number {
    return Math.round((value + Number.EPSILON) * 100) / 100;
  }

  private buildLocalFallback(
    userMessage: string,
    dashboard: {
      totalIncome: number;
      totalExpense: number;
      balance: number;
      transactionsCount: number;
    },
  ): string {
    if (!userMessage?.trim()) {
      throw new InternalServerErrorException('Mensagem invalida para gerar resposta');
    }

    if (dashboard.transactionsCount === 0) {
      return [
        'Ainda nao existem transacoes cadastradas para esta empresa.',
        'Cadastre receitas e despesas para gerar insights mais completos.',
      ].join(' ');
    }

    const trend =
      dashboard.balance >= 0
        ? 'Saldo positivo. Priorize crescimento com controle de custos.'
        : 'Saldo negativo. Priorize corte de despesas e revisao de precificacao.';

    return [
      `1. Diagnostico: receitas ${dashboard.totalIncome}, despesas ${dashboard.totalExpense}, saldo ${dashboard.balance}.`,
      `2. Analise: ${trend}`,
      '3. Recomendacoes praticas: revise os 3 maiores custos e valide precificacao por margem alvo.',
      '4. Proximos passos: compartilhe metas de faturamento e despesas para montar um plano de 30 dias.',
    ].join(' ');
  }
}
