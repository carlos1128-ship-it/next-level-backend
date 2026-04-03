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
import { AiChatRole, Plan, Prisma } from '@prisma/client';
import { GoogleGenerativeAI } from '@google/generative-ai';
import OpenAI from 'openai';
import { PrismaService } from '../../prisma/prisma.service';
import { QuotaExceededException } from '../../common/exceptions/quota-exceeded.exception';

type DetailLevel = 'low' | 'medium' | 'high';

export interface ChatResponseDto {
  success: true;
  message: string;
  tokensUsed?: number;
}

type AiUserRecord = {
  id: string;
  plan: Plan;
  detailLevel?: string | null;
  companyId: string | null;
  analyses?: Array<{ createdAt: Date }>;
};

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private genAI: GoogleGenerativeAI | null = null;
  private openai: OpenAI | null = null;

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    const geminiApiKey = this.configService.get<string>('GEMINI_API_KEY');
    if (geminiApiKey) {
      this.genAI = new GoogleGenerativeAI(geminiApiKey);
    }
    const openAiKey = this.configService.get<string>('OPENAI_API_KEY');
    if (openAiKey) {
      this.openai = new OpenAI({ apiKey: openAiKey });
    }
  }

  async analyzeSales(data: Record<string, unknown>, userId: string) {
    const fieldAvailability = await this.resolveUserFieldAvailability();
    const user = (await this.prisma.user.findUnique({
      where: { id: userId },
      select: this.buildUserSelect({
        includeAnalyses: true,
        fieldAvailability,
      }),
    })) as AiUserRecord | null;

    if (!user) {
      throw new NotFoundException('Usuario nao encontrado');
    }

    const now = new Date();
    const currentMonth = now.getMonth();
    const currentYear = now.getFullYear();
    const monthlyCount = (user.analyses ?? []).filter((analysis) => {
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

    const detailLevel = this.normalizeDetailLevel(user.detailLevel);
    const prompt = this.buildAnalysisPrompt(data, detailLevel);
    let text: string;
    try {
      ({ text } = await this.generateText(prompt, user.companyId || undefined, 'complex'));
    } catch (error) {
      this.logAiFailure('analyzeSales', error, {
        userId,
        companyId: user.companyId || undefined,
        hasGemini: Boolean(this.genAI),
        hasOpenAI: Boolean(this.openai),
      });
      throw this.toPublicAiException(error);
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
    const fieldAvailability = await this.resolveUserFieldAvailability();
    const user = (await this.prisma.user.findUnique({
      where: { id: userId },
      select: this.buildUserSelect({
        includeAnalyses: false,
        fieldAvailability,
      }),
    })) as AiUserRecord | null;

    if (!user) {
      throw new NotFoundException('Usuario nao encontrado');
    }

    if (!user.companyId) {
      throw new BadRequestException('User has no company');
    }

    const detailLevel = this.normalizeDetailLevel(user.detailLevel);
    const prompt = this.buildChatPrompt(message, detailLevel);
    const { text, tokensUsed } = await this.generateText(prompt, user.companyId, 'simple');

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

  private async resolveUserFieldAvailability() {
    const detailLevel = await this.prisma.hasColumn('User', 'detailLevel');
    return { detailLevel };
  }

  private buildUserSelect(options: {
    includeAnalyses: boolean;
    fieldAvailability: {
      detailLevel: boolean;
    };
  }): Prisma.UserSelect {
    return {
      id: true,
      plan: true,
      ...(options.fieldAvailability.detailLevel ? { detailLevel: true } : {}),
      companyId: true,
      ...(options.includeAnalyses
        ? {
            analyses: {
              select: {
                createdAt: true,
              },
            },
          }
        : {}),
    };
  }

  async generateText(
    prompt: string,
    companyId?: string,
    complexity: 'simple' | 'complex' = 'simple',
  ): Promise<{ text: string; tokensUsed?: number }> {
    if (!this.genAI && !this.openai) {
      throw new ServiceUnavailableException('Nenhum provedor de IA configurado');
    }

    const estimatedTokens = this.estimateTokens(prompt);
    if (companyId) {
      await this.ensureQuota(companyId, estimatedTokens);
    }

    const providers: Array<'gemini' | 'openai'> = [];
    if (this.genAI) providers.push('gemini');
    if (this.openai) providers.push('openai');

    let lastError: unknown;

    for (const provider of providers) {
      try {
        const result = await this.callProvider(provider, prompt, complexity);
        const tokensUsed = result.tokensUsed ?? estimatedTokens;
        if (companyId) {
          await this.consumeQuota(companyId, tokensUsed);
        }
        return { text: result.text, tokensUsed };
      } catch (error) {
        lastError = error;
        if (error instanceof QuotaExceededException) {
          throw error;
        }
        if (this.isQuotaExceededError(error)) {
          throw new HttpException(
            'Limite da IA excedido no momento. Tente novamente em alguns minutos.',
            HttpStatus.TOO_MANY_REQUESTS,
          );
        }
        this.logger.warn(
          `Provedor ${provider} falhou, tentando fallback: ${error instanceof Error ? error.message : error}`,
        );
      }
    }

    throw lastError || new InternalServerErrorException('Falha ao gerar resposta da IA');
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

  private toPublicAiException(error: unknown): HttpException {
    if (error instanceof QuotaExceededException) {
      return new HttpException(
        'Limite da IA excedido no momento. Tente novamente em alguns minutos.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    if (error instanceof HttpException) {
      return error;
    }
    if (this.isQuotaExceededError(error)) {
      return new HttpException(
        'Limite da IA excedido no momento. Tente novamente em alguns minutos.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    if (this.isServiceUnavailableError(error)) {
      return new ServiceUnavailableException(
        'Servico de IA indisponivel no momento. Verifique a configuracao do provedor e tente novamente.',
      );
    }
    return new InternalServerErrorException('Falha ao gerar insights com a IA.');
  }

  private logAiFailure(
    context: string,
    error: unknown,
    metadata?: Record<string, unknown>,
  ) {
    const status =
      error instanceof HttpException
        ? error.getStatus()
        : (error as { status?: unknown })?.status ||
          (error as { response?: { status?: unknown } })?.response?.status;
    const message = error instanceof Error ? error.message : String(error);
    this.logger.error(
      `[${context}] AI request failed${status ? ` (${status})` : ''}: ${message}`,
      metadata ? JSON.stringify(metadata) : undefined,
    );
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

  private estimateTokens(text: string): number {
    const normalized = text || '';
    return Math.max(1, Math.ceil(normalized.length / 4));
  }

  private async ensureQuota(companyId: string, tokensRequested: number) {
    const quota = await this.prisma.usageQuota.upsert({
      where: { companyId },
      update: {},
      create: {
        companyId,
        currentTier: 'FREE',
        billingCycleEnd: this.addDays(new Date(), 30),
      },
    });

    const limits: Record<string, number> = {
      FREE: 10000,
      PRO: 200000,
      ENTERPRISE: 10000000,
    };
    const limit = limits[quota.currentTier] ?? 10000;
    if (quota.llmTokensUsed + tokensRequested > limit) {
      throw new QuotaExceededException();
    }
  }

  private async consumeQuota(companyId: string, tokensUsed: number) {
    try {
      await this.prisma.usageQuota.update({
        where: { companyId },
        data: { llmTokensUsed: { increment: tokensUsed } },
      });
    } catch (error) {
      this.logger.warn(`Falha ao atualizar quota: ${error instanceof Error ? error.message : error}`);
    }
  }

  private async callProvider(
    provider: 'gemini' | 'openai',
    prompt: string,
    complexity: 'simple' | 'complex',
  ): Promise<{ text: string; tokensUsed?: number }> {
    if (provider === 'gemini') {
      const modelName = complexity === 'complex' ? 'gemini-2.5-pro' : 'gemini-2.5-flash';
      const model = this.genAI?.getGenerativeModel({ model: modelName });
      if (!model) throw new ServiceUnavailableException('Gemini nao configurado');
      const timeoutMs = 10000;
      const result = await Promise.race([
        model.generateContent(prompt),
        this.sleep(timeoutMs).then(() => {
          throw new ServiceUnavailableException('Gemini timeout');
        }),
      ]);
      const text = result.response.text()?.trim();
      if (!text) throw new InternalServerErrorException('Gemini retornou vazio');
      const tokensUsed = result.response.usageMetadata?.totalTokenCount;
      return { text, tokensUsed };
    }

    if (!this.openai) throw new ServiceUnavailableException('OpenAI nao configurado');
    const modelName = complexity === 'complex' ? 'gpt-4o' : 'gpt-4o-mini';
    const timeoutMs = 10000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.openai.chat.completions.create(
        {
          model: modelName,
          messages: [{ role: 'user', content: prompt }],
        },
        { signal: controller.signal },
      );
      const text = response.choices[0]?.message?.content?.trim();
      const tokensUsed = response.usage?.total_tokens;
      if (!text) throw new InternalServerErrorException('OpenAI retornou vazio');
      return { text, tokensUsed };
    } finally {
      clearTimeout(timer);
    }
  }

  private addDays(date: Date, days: number): Date {
    const clone = new Date(date);
    clone.setUTCDate(clone.getUTCDate() + days);
    return clone;
  }
}
