import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import { AlertsService } from '../alerts/alerts.service';

@Injectable()
export class AnalysisService {
  constructor(
    private prisma: PrismaService,
    private alertsService: AlertsService,
  ) {}

  @Cron('0 8 * * *')
  async runDailyAnalysis() {
    const companies = await this.prisma.company.findMany();

    for (const company of companies) {
      await this.analyzeCompany(company.id);
    }
  }

  async analyzeCompany(companyId: string) {
    const revenue = await this.prisma.sale.aggregate({
      where: { companyId },
      _sum: { amount: true },
    });

    const costs = await this.prisma.operationalCost.aggregate({
      where: { companyId },
      _sum: { amount: true },
    });

    const revenueTotal = Number(revenue._sum.amount ?? 0);
    const costTotal = Number(costs._sum.amount ?? 0);

    if (costTotal > revenueTotal * 0.5) {
      await this.alertsService.createAlert({
        companyId,
        type: 'HIGH_COST',
        severity: 'warning',
        message: 'Custos operacionais estão acima de 50% da receita',
      });
    }

    const recentSales = await this.prisma.sale.findMany({
      where: { companyId },
      orderBy: { createdAt: 'desc' },
      take: 10,
    });

    if (recentSales.length === 0) {
      await this.alertsService.createAlert({
        companyId,
        type: 'NO_SALES',
        severity: 'critical',
        message: 'Nenhuma venda recente detectada',
      });
    }
  }
}
