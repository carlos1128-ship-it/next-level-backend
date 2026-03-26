import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Competitor, MarketPrice, Prisma, Product } from '@prisma/client';
import axios from 'axios';
import { PrismaService } from '../../prisma/prisma.service';
import { AlertsService } from '../alerts/alerts.service';
import { StrategyService } from '../strategy/strategy.service';

type PriceSnapshot = {
  saved: MarketPrice;
  previous?: MarketPrice | null;
};

const marketIntelProductSelect = {
  id: true,
  companyId: true,
  name: true,
  price: true,
  createdAt: true,
} satisfies Prisma.ProductSelect;

type MarketIntelProduct = Prisma.ProductGetPayload<{
  select: typeof marketIntelProductSelect;
}>;

@Injectable()
export class MarketIntelligenceService {
  private readonly logger = new Logger(MarketIntelligenceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly alertsService: AlertsService,
    private readonly strategyService: StrategyService,
  ) {}

  @Cron('0 6 * * *')
  async runDailyPriceScan() {
    const companies = await this.prisma.company.findMany({ select: { id: true } });
    for (const company of companies) {
      await this.trackCompany(company.id);
    }
  }

  @Cron('0 7 * * 0')
  async runWeeklyTrendScan() {
    const companies = await this.prisma.company.findMany({ select: { id: true } });
    for (const company of companies) {
      await this.refreshCompanyTrends(company.id);
    }
  }

  async getOverview(userId: string, companyId?: string | null) {
    const company = await this.resolveCompany(userId, companyId);

    const products = await this.prisma.product.findMany({
      where: { companyId: company.id },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: marketIntelProductSelect,
    });

    const comparison = await Promise.all(
      products.map(async (product) => {
        const marketAvg = await this.marketAverage(product.id, company.id);
        const internalPrice = this.toNumber(product.price);
        const gapPct =
          marketAvg > 0 ? Number((((internalPrice - marketAvg) / marketAvg) * 100).toFixed(2)) : 0;
        const badge =
          marketAvg <= 0
            ? 'sem_dados'
            : internalPrice > marketAvg * 1.15
            ? 'acima'
            : 'competitivo';

        return {
          productId: product.id,
          productName: product.name,
          internalPrice,
          marketAverage: marketAvg,
          gapPct,
          badge,
        };
      }),
    );

    const trends = await this.prisma.marketTrend.findMany({
      where: { companyId: company.id },
      orderBy: { createdAt: 'desc' },
      take: 30,
    });

    const lastPrice = await this.prisma.marketPrice.findFirst({
      where: { companyId: company.id },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });

    return {
      comparison,
      trends,
      refreshedAt: lastPrice?.createdAt ?? null,
    };
  }

  async trackNow(userId: string, companyId?: string | null, productIds?: string[]) {
    const company = await this.resolveCompany(userId, companyId);
    return this.trackCompany(company.id, productIds);
  }

  async refreshTrends(userId: string, companyId?: string | null) {
    const company = await this.resolveCompany(userId, companyId);
    await this.refreshCompanyTrends(company.id);
    return { refreshed: true };
  }

  async analyzePriceGap(productId: string, companyId: string, emitAlert = true) {
    const product = await this.prisma.product.findFirst({
      where: { id: productId, companyId },
      select: marketIntelProductSelect,
    });
    if (!product) {
      throw new BadRequestException('Produto nao encontrado para a empresa');
    }

    const marketAvg = await this.marketAverage(productId, companyId);
    const internalPrice = this.toNumber(product.price);

    if (marketAvg <= 0) {
      return {
        status: 'sem_dados',
        internalPrice,
        marketAverage: 0,
        gapPct: 0,
      };
    }

    const gapPct = Number((((internalPrice - marketAvg) / marketAvg) * 100).toFixed(2));
    if (gapPct > 15 && emitAlert) {
      await this.alertsService.createAlert({
        companyId,
        type: 'MARKET_PRICE_GAP',
        severity: 'warning',
        message: `Preço fora de mercado detectado para o produto ${product.name}`,
      });
    }

    return {
      status: gapPct > 15 ? 'acima' : 'ok',
      internalPrice,
      marketAverage: marketAvg,
      gapPct,
    };
  }

  private async trackCompany(companyId: string, productIds?: string[]) {
    const products =
      productIds && productIds.length
        ? await this.prisma.product.findMany({
            where: { companyId, id: { in: productIds } },
            select: marketIntelProductSelect,
          })
        : await this.prisma.product.findMany({
            where: { companyId },
            orderBy: { createdAt: 'desc' },
            take: 10,
            select: marketIntelProductSelect,
          });

    const competitors = await this.ensureDefaultCompetitors(companyId);
    let tracked = 0;

    for (const product of products) {
      for (const competitor of competitors) {
        const snapshot = await this.fetchPriceForProduct(companyId, product, competitor);
        tracked += 1;
        await this.detectCompetitorOpportunity(companyId, product, competitor, snapshot);
      }
      await this.analyzePriceGap(product.id, companyId, true);
    }

    return { tracked, products: products.length, competitors: competitors.length };
  }

  private async fetchPriceForProduct(
    companyId: string,
    product: MarketIntelProduct,
    competitor: Competitor,
  ): Promise<PriceSnapshot> {
    const previous = await this.prisma.marketPrice.findFirst({
      where: { companyId, productId: product.id, competitorId: competitor.id },
      orderBy: { createdAt: 'desc' },
    });

    const basePrice = this.toNumber(product.price) || 100;
    const shouldMock = String(process.env.MARKET_SCRAPER_MODE || 'mock').toLowerCase() !== 'real';

    let price = this.randomizeAround(basePrice);

    if (!shouldMock && competitor.url && competitor.url.startsWith('http')) {
      try {
        const response = await axios.get<string>(competitor.url, { timeout: 5000 });
        const parsed = this.extractPriceFromHtml(response.data);
        price = parsed ?? this.randomizeAround(basePrice);
      } catch (error) {
        this.logger.debug(
          `Scraper fallback para ${competitor.name}: ${(error as Error)?.message || 'erro'}`,
        );
      }
    }

    const saved = await this.prisma.marketPrice.create({
      data: {
        companyId,
        productId: product.id,
        competitorId: competitor.id,
        price: new Prisma.Decimal(price),
        url: competitor.url,
      },
    });

    return { saved, previous };
  }

  private async marketAverage(productId: string, companyId: string): Promise<number> {
    const aggregated = await this.prisma.marketPrice.aggregate({
      where: { productId, companyId },
      _avg: { price: true },
    });
    return this.toNumber(aggregated._avg.price);
  }

  private async detectCompetitorOpportunity(
    companyId: string,
    product: MarketIntelProduct,
    competitor: Competitor,
    snapshot: PriceSnapshot,
  ) {
    if (!snapshot.previous) return;
    const prev = this.toNumber(snapshot.previous.price);
    const current = this.toNumber(snapshot.saved.price);
    if (prev <= 0) return;

    const variation = ((current - prev) / prev) * 100;
    if (variation < 5) return;

    const stockHigh = await this.isStockHigh(companyId, product);
    if (!stockHigh) return;

    await this.strategyService.suggestMarketOpportunity(companyId, {
      product: { id: product.id, name: product.name, price: this.toNumber(product.price) },
      competitor: { id: competitor.id, name: competitor.name, price: current },
      reason: `Concorrente ${competitor.name} aumentou ${variation.toFixed(1)}% em relação ao último valor.`,
    });
  }

  private async refreshCompanyTrends(companyId: string) {
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { sector: true, segment: true },
    });

    const seeds = this.resolveSectorTerms(company?.sector, company?.segment);
    const now = new Date();
    const entries = seeds.map((term) => ({
      companyId,
      term,
      volume: Math.round(500 + Math.random() * 4500),
      growthPercentage: Number((5 + Math.random() * 40).toFixed(2)),
      createdAt: now,
    }));

    await this.prisma.marketTrend.createMany({
      data: entries,
      skipDuplicates: true,
    });
  }

  private async ensureDefaultCompetitors(companyId: string): Promise<Competitor[]> {
    const existing = await this.prisma.competitor.findMany({ where: { companyId } });
    if (existing.length) return existing;

    await this.prisma.competitor.createMany({
      data: [
        {
          companyId,
          name: 'Mercado Livre',
          url: 'https://www.mercadolivre.com.br',
          category: 'marketplace',
        },
        {
          companyId,
          name: 'Shopee',
          url: 'https://shopee.com.br',
          category: 'marketplace',
        },
      ],
      skipDuplicates: true,
    });

    return this.prisma.competitor.findMany({ where: { companyId } });
  }

  private resolveSectorTerms(sector?: string | null, segment?: string | null): string[] {
    const normalized = `${sector || segment || ''}`.toLowerCase();
    if (normalized.includes('hamburg')) {
      return ['combo smash', 'delivery rapido', 'hamburguer artesanal', 'molho da casa', 'promo 2x1'];
    }
    if (normalized.includes('pizza')) {
      return ['pizza napoletana', 'bordas recheadas', 'pizza doce', 'pizza congelada', 'entrega expressa'];
    }
    if (normalized.includes('moda')) {
      return ['tendencia streetwear', 'sneakers limited', 'roupa comfy', 'basics premium', 'colab exclusiva'];
    }
    if (normalized.includes('saas') || normalized.includes('software')) {
      return ['automação vendas', 'crm leve', 'integração whatsapp', 'chatbot ai', 'painel tempo real'];
    }
    if (normalized.includes('beauty') || normalized.includes('beleza')) {
      return ['skincare vitamina c', 'hidratação profunda', 'protetor solar', 'makeup vegana', 'linha profissional'];
    }

    return [
      'frete gratis',
      'entrega no mesmo dia',
      'cashback',
      'desconto relampago',
      'tendencia tiktok',
      'kit promocional',
    ];
  }

  private async isStockHigh(companyId: string, product: MarketIntelProduct): Promise<boolean> {
    // Heurística: poucas vendas recentes => estoque parado/alto
    const recentSales = await this.prisma.sale.count({
      where: {
        companyId,
        productName: { equals: product.name, mode: 'insensitive' },
        occurredAt: { gte: this.addDays(new Date(), -14) },
      },
    });
    return recentSales <= 2;
  }

  private toNumber(value: Prisma.Decimal | number | bigint | null | undefined): number {
    if (value === null || value === undefined) return 0;
    if (typeof value === 'number') return value;
    if (typeof value === 'bigint') return Number(value);
    return Number(value);
  }

  private randomizeAround(base: number, variation = 0.1): number {
    const factor = 1 + (Math.random() * 2 - 1) * variation;
    return Number(Math.max(1, base * factor).toFixed(2));
  }

  private extractPriceFromHtml(html: string): number | null {
    const match = html.match(/(?:R\$|US\$|€)\s*([0-9]+[.,][0-9]{2})/i);
    if (!match) return null;
    const normalized = match[1].replace('.', '').replace(',', '.');
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? Number(parsed.toFixed(2)) : null;
  }

  private addDays(date: Date, days: number): Date {
    const clone = new Date(date);
    clone.setDate(clone.getDate() + days);
    return clone;
  }

  private async resolveCompany(userId: string, companyId?: string | null) {
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
      select: { id: true, sector: true, segment: true },
    });

    if (!company) {
      throw new BadRequestException('Empresa invalida');
    }

    return company;
  }
}
