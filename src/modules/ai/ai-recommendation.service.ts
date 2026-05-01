import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { BusinessMetricSnapshot } from './business-intelligence.types';

@Injectable()
export class AiRecommendationService {
  constructor(private readonly prisma: PrismaService) {}

  async generateRecommendations(companyId: string, metrics: BusinessMetricSnapshot) {
    const recommendations: Array<{
      category: string;
      title: string;
      description: string;
      expectedImpact: string;
      actionType: string;
      metadataJson?: Record<string, unknown>;
    }> = [];

    const bestProduct = metrics.salesByProduct[0];
    if (bestProduct) {
      recommendations.push({
        category: 'sales',
        title: `Campanha para ${bestProduct.productName}`,
        description: `Crie uma acao comercial para clientes que ja compraram ou perguntaram sobre ${bestProduct.productName}, pois o item lidera o faturamento do periodo.`,
        expectedImpact: 'Aumentar receita aproveitando demanda real ja comprovada.',
        actionType: 'suggest_campaign',
        metadataJson: { productName: bestProduct.productName, revenue: bestProduct.revenue },
      });
    }

    const lowMarginProduct = metrics.profitByProduct.find((item) => item.margin !== null && item.margin < 15);
    if (lowMarginProduct) {
      recommendations.push({
        category: 'products',
        title: `Revisar margem de ${lowMarginProduct.productName}`,
        description: `O produto vende, mas a margem estimada esta baixa. Revise preco, custo, frete e descontos antes de escalar campanhas.`,
        expectedImpact: 'Proteger lucro liquido e evitar vender mais com pouco retorno.',
        actionType: 'review_pricing',
        metadataJson: lowMarginProduct,
      });
    }

    const peakHour = metrics.peakHours[0];
    if (peakHour) {
      recommendations.push({
        category: 'marketing',
        title: `Ativar ofertas perto das ${peakHour.hour}h`,
        description: `O pico de vendas aparece nesse horario. Programe campanhas e atendimento ativo antes desse periodo.`,
        expectedImpact: 'Melhorar conversao usando horario de maior intencao.',
        actionType: 'schedule_campaign',
        metadataJson: peakHour,
      });
    }

    for (const recommendation of recommendations) {
      await this.prisma.aiRecommendation.create({
        data: {
          companyId,
          ...recommendation,
          metadataJson: recommendation.metadataJson as Prisma.InputJsonObject | undefined,
        },
      });
    }

    return recommendations;
  }

  async listRecommendations(companyId: string, status?: string) {
    return this.prisma.aiRecommendation.findMany({
      where: {
        companyId,
        ...(status ? { status } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  async updateStatus(companyId: string, id: string, status: string) {
    return this.prisma.aiRecommendation.updateMany({
      where: { id, companyId },
      data: { status },
    });
  }
}
