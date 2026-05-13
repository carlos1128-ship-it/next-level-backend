import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import { MercadoLivreSyncService } from './mercado-livre-sync.service';

@Injectable()
export class MercadoLivreCronService {
  private readonly logger = new Logger(MercadoLivreCronService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly syncService: MercadoLivreSyncService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async syncDailyOrdersAndItems() {
    const tokens = await this.prisma.mercadoLivreOAuthToken.findMany({
      where: { status: 'connected' },
      select: { companyId: true, lastSyncAt: true },
    });

    for (const token of tokens) {
      try {
        await this.syncService.syncProducts(token.companyId);
        await this.syncService.syncOrders(token.companyId, undefined, token.lastSyncAt || undefined);
        await this.prisma.mercadoLivreOAuthToken.update({
          where: { companyId: token.companyId },
          data: { lastSyncAt: new Date() },
        });
      } catch (error) {
        this.logger.error(`Falha no ETL diario Mercado Livre ${token.companyId}`, error as Error);
      }
    }
  }

  @Cron(CronExpression.EVERY_HOUR)
  async syncHourlyStock() {
    const tokens = await this.prisma.mercadoLivreOAuthToken.findMany({
      where: { status: 'connected' },
      select: { companyId: true },
    });

    for (const token of tokens) {
      try {
        await this.syncService.syncProducts(token.companyId);
      } catch (error) {
        this.logger.error(`Falha ao atualizar estoque Mercado Livre ${token.companyId}`, error as Error);
      }
    }
  }
}
