import { BadRequestException, Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ForecastSnapshot, ForecastType, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AlertsService } from '../alerts/alerts.service';
import { StrategyService } from '../strategy/strategy.service';

export interface ForecastSeriesPoint {
  date: string;
  value: number;
}

export interface ForecastResponse {
  status: 'ok' | 'insufficient_data';
  type: ForecastType;
  historicalData?: ForecastSeriesPoint[];
  predictedData?: ForecastSeriesPoint[];
  confidenceInterval?: { lower: number; upper: number; margin: number };
  accuracyScore?: number;
  generatedAt?: Date;
  message?: string;
}

@Injectable()
export class ForecastService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly alertsService: AlertsService,
    private readonly strategyService: StrategyService,
  ) {}

  @Cron('0 3 * * *')
  async runDailyForecast() {
    const companies = await this.prisma.company.findMany({
      select: { id: true },
    });

    for (const company of companies) {
      for (const type of [
        ForecastType.SALES,
        ForecastType.DEMAND,
        ForecastType.REVENUE,
      ]) {
        await this.generateAndPersist(company.id, type);
      }
    }
  }

  async getForecast(
    userId: string,
    type: ForecastType,
    companyId?: string | null,
    horizon = 30,
  ): Promise<ForecastResponse> {
    const company = await this.resolveCompany(userId, companyId);
    const latest = await this.prisma.forecastSnapshot.findFirst({
      where: { companyId: company.id, type },
      orderBy: { createdAt: 'desc' },
    });

    const isFresh =
      latest && this.isFresh(latest.createdAt, 24 /* hours */);

    if (latest && isFresh) {
      return this.mapSnapshot(latest, type, horizon);
    }

    const computed = await this.generateAndPersist(company.id, type);
    if (computed.status === 'ok') {
      computed.predictedData =
        computed.predictedData?.slice(0, Math.max(1, horizon)) || [];
    }
    return computed;
  }

  private async generateAndPersist(
    companyId: string,
    type: ForecastType,
  ): Promise<ForecastResponse> {
    const forecast = await this.buildForecast(companyId, type, 30);

    if (forecast.status === 'insufficient_data') {
      return forecast;
    }

    await this.prisma.forecastSnapshot.create({
      data: {
        companyId,
        type,
        data: {
          historicalData: forecast.historicalData,
          predictedData: forecast.predictedData,
          confidenceInterval: forecast.confidenceInterval,
        } as Prisma.InputJsonValue,
        accuracyScore: forecast.accuracyScore || 0,
      },
    });

    if (type === ForecastType.REVENUE) {
      await this.checkBusinessRisks(companyId, forecast);
    }

    return forecast;
  }

  private async buildForecast(
    companyId: string,
    type: ForecastType,
    horizon: number,
  ): Promise<ForecastResponse> {
    const today = new Date();
    const startDate = this.addDays(today, -90);

    const sales = await this.prisma.sale.findMany({
      where: {
        companyId,
        occurredAt: { gte: startDate },
      },
      select: { occurredAt: true, amount: true },
    });

    const dailyTotals = new Map<string, number>();

    for (const sale of sales) {
      const dateKey = this.toDateKey(sale.occurredAt || today);
      const current = dailyTotals.get(dateKey) || 0;
      const amount = Number(sale.amount || 0);
      const value =
        type === ForecastType.DEMAND ? 1 : amount;
      dailyTotals.set(dateKey, current + value);
    }

    const historicalData: ForecastSeriesPoint[] = [];
    const daysDiff = Math.max(
      0,
      Math.round(
        (today.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24),
      ),
    );

    for (let i = 0; i <= daysDiff; i++) {
      const date = this.addDays(startDate, i);
      const key = this.toDateKey(date);
      const value = Number((dailyTotals.get(key) || 0).toFixed(2));
      historicalData.push({ date: key, value });
    }

    const daysWithData = historicalData.filter((d) => d.value > 0).length;
    if (daysWithData < 14) {
      return {
        status: 'insufficient_data',
        type,
        message: 'Dados insuficientes para gerar previsao (minimo 14 dias).',
      };
    }

    const windowSize = Math.min(7, Math.max(3, Math.floor(historicalData.length / 6)));
    const seriesValues = historicalData.map((p) => p.value);
    const predictedData: ForecastSeriesPoint[] = [];
    const lastHistoricalDate = new Date(
      `${historicalData[historicalData.length - 1].date}T00:00:00Z`,
    );

    for (let i = 1; i <= horizon; i++) {
      const window = seriesValues.slice(-windowSize);
      const windowAvg =
        window.reduce((sum, v) => sum + v, 0) / Math.max(1, window.length);
      const forecastValue = Number(windowAvg.toFixed(2));
      seriesValues.push(forecastValue);

      const nextDate = this.addDays(lastHistoricalDate, i);
      predictedData.push({
        date: this.toDateKey(nextDate),
        value: forecastValue,
      });
    }

    const historicalValues = historicalData.map((h) => h.value);
    const meanHist = this.mean(historicalValues);
    const stdHist = this.standardDeviation(historicalValues);
    const predictedMean = this.mean(predictedData.map((p) => p.value));
    const margin = Number(stdHist.toFixed(2));

    const accuracyScore =
      meanHist > 0 ? Math.max(0, Math.min(1, 1 - stdHist / (meanHist * 2))) : 0;

    return {
      status: 'ok',
      type,
      historicalData,
      predictedData,
      confidenceInterval: {
        lower: Number(Math.max(0, predictedMean - margin).toFixed(2)),
        upper: Number((predictedMean + margin).toFixed(2)),
        margin,
      },
      accuracyScore: Number(accuracyScore.toFixed(3)),
      generatedAt: new Date(),
    };
  }

  private mapSnapshot(
    snapshot: ForecastSnapshot,
    type: ForecastType,
    horizon: number,
  ): ForecastResponse {
    const payload = (snapshot.data || {}) as {
      historicalData?: ForecastSeriesPoint[];
      predictedData?: ForecastSeriesPoint[];
      confidenceInterval?: { lower: number; upper: number; margin: number };
    };

    const predicted = Array.isArray(payload.predictedData)
      ? payload.predictedData.slice(0, Math.max(1, horizon))
      : [];

    return {
      status: 'ok',
      type,
      historicalData: Array.isArray(payload.historicalData)
        ? payload.historicalData
        : [],
      predictedData: predicted,
      confidenceInterval: payload.confidenceInterval,
      accuracyScore: snapshot.accuracyScore || 0,
      generatedAt: snapshot.createdAt,
    };
  }

  private async checkBusinessRisks(
    companyId: string,
    forecast: ForecastResponse,
  ) {
    if (
      forecast.status !== 'ok' ||
      !forecast.historicalData?.length ||
      !forecast.predictedData?.length
    ) {
      return;
    }

    const last30 = forecast.historicalData.slice(-30);
    const next15 = forecast.predictedData.slice(0, 15);
    const last30Avg = this.mean(last30.map((d) => d.value));
    const next15Avg = this.mean(next15.map((d) => d.value));

    if (last30Avg > 0 && next15Avg < last30Avg * 0.8) {
      const recentAlert = await this.prisma.alert.findFirst({
        where: {
          companyId,
          type: 'FORECAST_REVENUE_DROP',
          createdAt: { gte: this.addDays(new Date(), -1) },
        },
      });

      if (!recentAlert) {
        await this.alertsService.createAlert({
          companyId,
          type: 'FORECAST_REVENUE_DROP',
          severity: 'HIGH',
          message:
            'Risco de queda de faturamento detectado para os próximos 15 dias. Sugerimos ação de marketing imediata.',
        });
      }

      const dropPercent = ((last30Avg - next15Avg) / last30Avg) * 100;
      await this.strategyService.suggestRevenueRecoveryPlan(
        companyId,
        Number(dropPercent.toFixed(1)),
      );
    }
  }

  private async resolveCompany(
    userId: string,
    companyId?: string | null,
  ): Promise<{ id: string }> {
    const normalizedCompanyId = companyId?.trim();
    const company = await this.prisma.company.findFirst({
      where: normalizedCompanyId
        ? {
            id: normalizedCompanyId,
            OR: [{ userId }, { users: { some: { id: userId } } }],
          }
        : {
            OR: [{ userId }, { users: { some: { id: userId } } }],
          },
      select: { id: true },
    });

    if (!company) {
      throw new BadRequestException('Empresa invalida para forecast');
    }

    return company;
  }

  private toDateKey(date: Date): string {
    return date.toISOString().slice(0, 10);
  }

  private addDays(date: Date, days: number): Date {
    const clone = new Date(date);
    clone.setUTCDate(clone.getUTCDate() + days);
    return clone;
  }

  private isFresh(createdAt: Date, hours: number): boolean {
    const threshold = this.addDays(new Date(createdAt), 0);
    threshold.setUTCHours(threshold.getUTCHours() + hours);
    return threshold.getTime() > Date.now();
  }

  private mean(values: number[]): number {
    if (!values.length) return 0;
    const sum = values.reduce((acc, val) => acc + val, 0);
    return sum / values.length;
  }

  private standardDeviation(values: number[]): number {
    if (!values.length) return 0;
    const mean = this.mean(values);
    const variance =
      values.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) /
      values.length;
    return Math.sqrt(variance);
  }
}
