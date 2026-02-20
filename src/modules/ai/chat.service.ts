import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiChatRole } from '@prisma/client';
import OpenAI from 'openai';
import { DashboardService } from '../dashboard/dashboard.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ChatRequestDto } from './dto/chat-request.dto';

export interface ChatReply {
  message: string;
  source: 'openai' | 'local';
}

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);
  private readonly openai: OpenAI | null;
  private readonly model: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly dashboardService: DashboardService,
  ) {
    const apiKey = this.configService.get<string>('OPENAI_API_KEY');
    this.openai = apiKey ? new OpenAI({ apiKey }) : null;
    this.model = this.configService.get<string>('OPENAI_MODEL') || 'gpt-4o-mini';
  }

  async chat(userId: string, dto: ChatRequestDto): Promise<ChatReply> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, companyId: true },
    });
    if (!user) {
      throw new BadRequestException('Usuario nao encontrado');
    }
    if (!user.companyId) {
      throw new BadRequestException('User has no company');
    }
    const companyId = dto.companyId?.trim() || user.companyId || undefined;
    console.log('companyId recebido:', companyId);
    if (!companyId) {
      throw new BadRequestException('companyId nao informado');
    }

    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { id: true, name: true, currency: true },
    });
    if (!company) {
      throw new BadRequestException('Empresa nao encontrada para o companyId informado');
    }

    if (user.companyId && user.companyId !== companyId) {
      throw new BadRequestException('companyId nao corresponde ao usuario autenticado');
    }

    const [dashboard, recentTransactions] = await Promise.all([
      this.dashboardService.getDashboard(companyId),
      this.prisma.financialTransaction.findMany({
        where: { companyId },
        orderBy: { occurredAt: 'desc' },
        take: 5,
        select: { type: true, amount: true, description: true, occurredAt: true },
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

    const reply = await this.buildReply(dto.message, context, dashboard);

    await this.prisma.$transaction([
      this.prisma.aiChatMessage.create({
        data: {
          userId: user.id,
          companyId,
          role: AiChatRole.USER,
          content: dto.message.trim(),
        },
      }),
      this.prisma.aiChatMessage.create({
        data: {
          userId: user.id,
          companyId,
          role: AiChatRole.ASSISTANT,
          content: reply.message,
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
  ): Promise<ChatReply> {
    if (!this.openai) {
      return { message: this.buildLocalFallback(userMessage, dashboard), source: 'local' };
    }

    try {
      const response = await this.openai.responses.create({
        model: this.model,
        input: [
          {
            role: 'system',
            content:
              'Voce e um assistente financeiro para um SaaS. Responda com objetividade e foco em acao.',
          },
          {
            role: 'user',
            content: `Contexto financeiro:\n${context}\n\nPergunta:\n${userMessage}`,
          },
        ],
      });

      const text = response.output_text?.trim();
      if (!text) {
        return { message: this.buildLocalFallback(userMessage, dashboard), source: 'local' };
      }

      return { message: text, source: 'openai' };
    } catch (error) {
      this.logger.warn(
        `Falha ao consultar OpenAI; usando fallback local. Erro: ${
          error instanceof Error ? error.message : 'desconhecido'
        }`,
      );
      return { message: this.buildLocalFallback(userMessage, dashboard), source: 'local' };
    }
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
