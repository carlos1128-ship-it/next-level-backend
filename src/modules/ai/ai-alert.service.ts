import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { BusinessMetricSnapshot } from './business-intelligence.types';

@Injectable()
export class AiAlertService {
  constructor(private readonly prisma: PrismaService) {}

  async generateMetricAlerts(companyId: string, metrics: BusinessMetricSnapshot) {
    const alerts: Array<{
      type: string;
      severity: string;
      title: string;
      message: string;
      recommendation: string;
      metadataJson?: Record<string, unknown>;
    }> = [];

    if (metrics.risks.includes('sales_drop')) {
      alerts.push({
        type: 'SALES_DROP',
        severity: 'high',
        title: 'Queda de vendas detectada',
        message: 'O faturamento caiu em relacao ao periodo anterior.',
        recommendation: 'Revise produtos com queda e acione clientes recentes com uma oferta objetiva.',
        metadataJson: { period: metrics.period },
      });
    }

    if (metrics.risks.includes('low_margin')) {
      alerts.push({
        type: 'LOW_MARGIN_PRODUCT',
        severity: 'high',
        title: 'Margem baixa',
        message: `A margem do periodo esta em ${metrics.margin ?? 0}%.`,
        recommendation: 'Revise custos, descontos e precos dos produtos com maior volume.',
        metadataJson: { margin: metrics.margin },
      });
    }

    if (metrics.risks.includes('operational_waste')) {
      alerts.push({
        type: 'OPERATIONAL_WASTE',
        severity: 'medium',
        title: 'Desperdicio operacional acima do ideal',
        message: `Custos operacionais representam ${metrics.operationalWaste ?? 0}% da receita.`,
        recommendation: 'Mapeie custos recorrentes e corte despesas sem impacto direto em receita.',
        metadataJson: { operationalWaste: metrics.operationalWaste },
      });
    }

    for (const alert of alerts) {
      await this.prisma.aiAlert.create({
        data: {
          companyId,
          ...alert,
          metadataJson: alert.metadataJson as Prisma.InputJsonObject | undefined,
        },
      });
    }

    return alerts;
  }

  async listAlerts(companyId: string, status?: string) {
    return this.prisma.aiAlert.findMany({
      where: {
        companyId,
        ...(status ? { status } : {}),
      },
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      take: 50,
    });
  }

  async resolveAlert(companyId: string, id: string) {
    return this.prisma.aiAlert.updateMany({
      where: { id, companyId },
      data: { status: 'resolved', resolvedAt: new Date() },
    });
  }
}
