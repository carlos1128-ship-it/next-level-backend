import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiChatRole } from '@prisma/client';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { PrismaService } from '../../prisma/prisma.service';

type DetailLevel = 'low' | 'medium' | 'high';

export interface ChatResponseDto {
  success: true;
  message: string;
  tokensUsed?: number;
}

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private genAI: GoogleGenerativeAI | null = null;

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    const geminiApiKey = this.configService.get<string>('GEMINI_API_KEY');
    if (geminiApiKey) {
      this.genAI = new GoogleGenerativeAI(geminiApiKey);
    }
  }

  async analyzeSales(data: Record<string, unknown>, userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { analyses: true },
    });

    if (!user) {
      throw new NotFoundException('Usuario nao encontrado');
    }

    const now = new Date();
    const currentMonth = now.getMonth();
    const currentYear = now.getFullYear();
    const monthlyCount = user.analyses.filter((analysis) => {
      const createdAt = new Date(analysis.createdAt);
      return (
        createdAt.getMonth() === currentMonth &&
        createdAt.getFullYear() === currentYear
      );
    }).length;

    if (user.plan === 'FREE' && monthlyCount >= 5) {
      throw new ForbiddenException(
        'Limite mensal atingido. Faca upgrade para PRO.',
      );
    }

    if (!this.genAI) {
      throw new ServiceUnavailableException(
        'Servico de IA indisponivel no momento',
      );
    }

    const detailLevel = this.normalizeDetailLevel(user.detailLevel);
    const prompt = this.buildAnalysisPrompt(data, detailLevel);
    let text: string;
    try {
      ({ text } = await this.generateText(prompt));
    } catch (error) {
      if (this.isRecoverableAiError(error)) {
        text = this.buildLocalAnalysisFallback(data);
      } else {
        throw error;
      }
    }

    await this.prisma.analysis.create({
      data: {
        content: text,
        userId,
      },
    });

    return text;
  }

  async getAnalysisHistory(userId: string) {
    return this.prisma.analysis.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async chat(message: string, userId: string): Promise<ChatResponseDto> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, companyId: true, detailLevel: true },
    });

    if (!user) {
      throw new NotFoundException('Usuario nao encontrado');
    }

    if (!this.genAI) {
      throw new ServiceUnavailableException(
        'Servico de IA indisponivel no momento',
      );
    }
    if (!user.companyId) {
      throw new BadRequestException('User has no company');
    }

    const detailLevel = this.normalizeDetailLevel(user.detailLevel);
    const prompt = this.buildChatPrompt(message, detailLevel);
    const { text, tokensUsed } = await this.generateText(prompt);

    await this.prisma.$transaction([
      this.prisma.aiChatMessage.create({
        data: {
          userId: user.id,
          companyId: user.companyId,
          role: AiChatRole.USER,
          content: message,
        },
      }),
      this.prisma.aiChatMessage.create({
        data: {
          userId: user.id,
          companyId: user.companyId,
          role: AiChatRole.ASSISTANT,
          content: text,
          tokensUsed,
        },
      }),
    ]);

    return {
      success: true,
      message: text,
      ...(tokensUsed ? { tokensUsed } : {}),
    };
  }

  private async generateText(
    prompt: string,
  ): Promise<{ text: string; tokensUsed?: number }> {
    const model = this.genAI?.getGenerativeModel({
      model: 'gemini-2.5-flash',
    });

    if (!model) {
      throw new ServiceUnavailableException('Modelo de IA indisponivel');
    }

    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const result = await model.generateContent(prompt);
        const text = result.response.text()?.trim();
        if (!text) {
          throw new InternalServerErrorException(
            'IA retornou resposta vazia para a solicitacao',
          );
        }
        const tokensUsed = result.response.usageMetadata?.totalTokenCount;
        return { text, tokensUsed };
      } catch (error) {
        if (error instanceof InternalServerErrorException) {
          throw error;
        }
        if (this.isQuotaExceededError(error)) {
          this.logger.warn(
            `Quota Gemini excedida: ${error instanceof Error ? error.message : 'erro desconhecido'}`,
          );
          throw new HttpException(
            'Limite da IA excedido no momento. Tente novamente em alguns minutos.',
            HttpStatus.TOO_MANY_REQUESTS,
          );
        }
        if (this.isServiceUnavailableError(error)) {
          if (attempt < maxAttempts) {
            const delayMs = 400 * Math.pow(2, attempt - 1);
            await this.sleep(delayMs);
            continue;
          }
          this.logger.warn(
            `IA indisponivel apos ${maxAttempts} tentativas: ${error instanceof Error ? error.message : 'erro desconhecido'}`,
          );
          throw new ServiceUnavailableException(
            'IA temporariamente indisponivel. Tente novamente em alguns minutos.',
          );
        }
        this.logger.error(
          `Falha ao gerar resposta da IA: ${error instanceof Error ? error.message : 'erro desconhecido'}`,
        );
        throw new InternalServerErrorException('Falha ao gerar resposta da IA');
      }
    }

    throw new InternalServerErrorException('Falha ao gerar resposta da IA');
  }

  private isQuotaExceededError(error: unknown): boolean {
    const message = error instanceof Error ? error.message.toLowerCase() : '';
    if (
      message.includes('429') ||
      message.includes('quota') ||
      message.includes('too many requests') ||
      message.includes('rate limit')
    ) {
      return true;
    }

    if (error && typeof error === 'object') {
      const maybeStatus = (error as { status?: unknown }).status;
      if (maybeStatus === 429) return true;
    }

    return false;
  }

  private isServiceUnavailableError(error: unknown): boolean {
    const message = error instanceof Error ? error.message.toLowerCase() : '';
    if (
      message.includes('503') ||
      message.includes('service unavailable') ||
      message.includes('temporarily unavailable') ||
      message.includes('high demand')
    ) {
      return true;
    }

    if (error && typeof error === 'object') {
      const maybeStatus = (error as { status?: unknown }).status;
      const responseStatus = (error as { response?: { status?: unknown } }).response?.status;
      if (maybeStatus === 503 || responseStatus === 503) return true;
    }

    return false;
  }

  private isRecoverableAiError(error: unknown): boolean {
    if (error instanceof ServiceUnavailableException) {
      return true;
    }
    if (error instanceof HttpException && error.getStatus() === HttpStatus.TOO_MANY_REQUESTS) {
      return true;
    }
    return this.isServiceUnavailableError(error) || this.isQuotaExceededError(error);
  }

  private buildLocalAnalysisFallback(data: Record<string, unknown>): string {
    const metrics = [
      `receita=${data.revenue ?? 'n/d'}`,
      `perdas=${data.losses ?? 'n/d'}`,
      `lucro=${data.profit ?? 'n/d'}`,
      `caixa=${data.cashflow ?? 'n/d'}`,
    ]
      .map(String)
      .join(' | ');

    return [
      '[Modo offline] IA principal indisponivel; heuristica rapida.',
      `Resumo: ${metrics}`,
      'Riscos: validar dados e limites antes de agir.',
      'Oportunidades: rever mix, canais e horarios de pico.',
      'Recomendacao: priorize custos recorrentes e precificacao alvo.',
    ].join('\n');
  }

  private sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private normalizeDetailLevel(value: string | null | undefined): DetailLevel {
    if (value === 'low' || value === 'high') {
      return value;
    }
    return 'medium';
  }

  private buildAnalysisPrompt(
    data: Record<string, unknown>,
    detailLevel: DetailLevel,
  ): string {
    const style = this.detailStyle(detailLevel);

    return [
      'Voce e um consultor estrategico de vendas SaaS.',
      'Nao repita os mesmos argumentos. Evite respostas longas e redundantes.',
      style,
      'Gere exatamente 4 secoes: padroes, riscos, oportunidades, recomendacoes.',
      'Use linguagem clara, objetiva e orientada a acao.',
      `Dados: ${JSON.stringify(data)}`,
    ].join('\n');
  }

  private buildChatPrompt(message: string, detailLevel: DetailLevel): string {
    const style = this.detailStyle(detailLevel);
    return [
      'Voce e um assistente de negocios para SaaS B2B.',
      'Responda sem repeticao e sem textos prolixos.',
      style,
      'Se a pergunta estiver incompleta, diga qual dado falta em no maximo 2 frases.',
      `Pergunta do usuario: ${message}`,
    ].join('\n');
  }

  private detailStyle(detailLevel: DetailLevel): string {
    if (detailLevel === 'low') {
      return 'Nivel de detalhe: baixo. Responda em ate 5 linhas.';
    }
    if (detailLevel === 'high') {
      return 'Nivel de detalhe: alto. Responda em ate 220 palavras e use no maximo 6 bullets.';
    }
    return 'Nivel de detalhe: medio. Responda em ate 120 palavras e use no maximo 4 bullets.';
  }
}
