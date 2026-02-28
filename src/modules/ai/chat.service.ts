import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiChatRole } from '@prisma/client';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { DashboardService } from '../dashboard/dashboard.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ChatRequestDto } from './dto/chat-request.dto';

export interface ChatReply {
  response: string;
  source: 'gemini' | 'local';
}

type DetailLevel = 'low' | 'medium' | 'high';

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);
  private readonly genAI: GoogleGenerativeAI | null;
  private readonly model: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly dashboardService: DashboardService,
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
      select: { id: true, name: true, currency: true },
    });

    // Fallback for stale companyId in client state.
    if (!company && user.companyId) {
      company = await this.prisma.company.findFirst({
        where: {
          id: user.companyId,
          OR: [{ userId: user.id }, { users: { some: { id: user.id } } }],
        },
        select: { id: true, name: true, currency: true },
      });
    }

    if (!company) {
      company = await this.prisma.company.findFirst({
        where: {
          OR: [{ userId: user.id }, { users: { some: { id: user.id } } }],
        },
        orderBy: { createdAt: 'asc' },
        select: { id: true, name: true, currency: true },
      });
    }

    if (!company?.id) {
      throw new BadRequestException(
        'Empresa nao encontrada para o companyId informado',
      );
    }

    const detailLevel = this.normalizeDetailLevel(user.detailLevel);

    const [dashboard, recentTransactions] = await Promise.all([
      this.dashboardService.getDashboard(company.id),
      this.prisma.financialTransaction.findMany({
        where: { companyId: company.id },
        orderBy: { date: 'desc' },
        take: 5,
        select: { type: true, amount: true, description: true, category: true, date: true },
      }),
    ]);

    const context = [
      `Empresa: ${company.name}`,
      `Moeda: ${company.currency}`,
      `Total receitas: ${dashboard.totalIncome}`,
      `Total despesas: ${dashboard.totalExpense}`,
      `Saldo: ${dashboard.balance}`,
      `Quantidade de transacoes: ${dashboard.transactionsCount}`,
      `Ultimas transacoes: ${JSON.stringify(recentTransactions)}`,
    ].join('\n');

    const reply = await this.buildReply(dto.message, context, detailLevel, dashboard);

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
    detailLevel: DetailLevel,
    dashboard: {
      totalIncome: number;
      totalExpense: number;
      balance: number;
      transactionsCount: number;
    },
  ): Promise<ChatReply> {
    if (!this.genAI) {
      return { response: this.buildLocalFallback(userMessage, dashboard), source: 'local' };
    }

    try {
      const model = this.genAI.getGenerativeModel({ model: this.model });
      const prompt = [
        'Voce e um assistente financeiro para uma operacao SaaS.',
        'Responda em portugues do Brasil, com objetividade, sem repeticao e com foco em acao.',
        this.detailStyle(detailLevel),
        'Quando fizer recomendacoes, inclua no maximo 3 passos praticos.',
        `Contexto financeiro:\n${context}`,
        `Pergunta do usuario:\n${userMessage}`,
      ].join('\n\n');

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
      `Resumo atual: receitas ${dashboard.totalIncome}, despesas ${dashboard.totalExpense}, saldo ${dashboard.balance}.`,
      trend,
      'Posso detalhar por categoria se voce enviar mais transacoes com categoria preenchida.',
    ].join(' ');
  }
}
