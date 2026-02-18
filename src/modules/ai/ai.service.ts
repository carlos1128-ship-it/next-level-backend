import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class AiService {
  private genAI: GoogleGenerativeAI | null = null;

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    const geminiApiKey = process.env.GEMINI_API_KEY;
    if (geminiApiKey) {
      this.genAI = new GoogleGenerativeAI(geminiApiKey);
    }
  }

  async analyzeSales(data: any, userId: string) {
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
        'Limite mensal atingido. Faça upgrade para PRO.',
      );
    }

    if (!this.genAI) {
      return 'IA nao configurada. Defina GEMINI_API_KEY no .env para usar analise.';
    }

    const model = this.genAI.getGenerativeModel({
      model: 'gemini-1.5-flash',
    });

    const prompt = `
Você é um consultor estratégico de vendas SaaS.

Analise os dados abaixo e gere:

1. Padrões de crescimento
2. Riscos
3. Oportunidades
4. Recomendações práticas

Dados:
${JSON.stringify(data)}
`;

    const result = await model.generateContent(prompt);
    const aiResponse = result.response.text();

    await this.prisma.analysis.create({
      data: {
        content: aiResponse,
        userId,
      },
    });

    return aiResponse;
  }

  async getAnalysisHistory(userId: string) {
    return this.prisma.analysis.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async chat(message: string, userId: string) {
    if (!this.genAI) {
      return 'IA nao configurada. Defina GEMINI_API_KEY no .env para usar chat.';
    }

    const model = this.genAI.getGenerativeModel({
      model: 'gemini-1.5-flash',
    });

    const result = await model.generateContent(message);

    return result.response.text();
  }
}
