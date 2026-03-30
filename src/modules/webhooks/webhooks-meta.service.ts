import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { Prisma } from '@prisma/client';

/**
 * Processa webhooks do Meta (Ads) e persiste custos de anúncios.
 * company_id deve ser mapeado via META_AD_ACCOUNT_TO_COMPANY (JSON: { "ad_account_id": "company_id" }).
 */
@Injectable()
export class WebhooksMetaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  async processWebhook(payload: Record<string, unknown>) {
    if (payload['object'] !== 'ad_account') {
      return { received: true, skipped: 'Objeto não é ad_account' };
    }

    const entry = (payload['entry'] as Array<Record<string, unknown>>)?.[0];
    const changes = entry?.['changes'] as Array<{ field: string; value?: { ad_id?: string; spend?: string } }> | undefined;
    if (!changes?.length) {
      return { received: true, skipped: 'Sem changes' };
    }

    const companyId = this.resolveCompanyId(payload);
    if (!companyId) {
      return { received: true, skipped: 'company_id não configurado para este webhook' };
    }

    for (const change of changes) {
      if (change.field === 'spend' && change.value?.spend != null) {
        const amount = parseFloat(change.value.spend) || 0;
        await this.prisma.adSpend.create({
          data: {
            companyId,
            amount: new Prisma.Decimal(amount),
            spentAt: new Date(),
            source: 'meta',
            metadata: { adId: change.value.ad_id, raw: change },
          },
        });
      }
    }

    return { received: true, synced: true };
  }

  private resolveCompanyId(payload: Record<string, unknown>): string | null {
    const entry = (payload['entry'] as Array<Record<string, unknown>>)?.[0];
    const id = entry?.['id'] as string | undefined;
    const mapping = this.configService?.get<string>('META_AD_ACCOUNT_TO_COMPANY');
    if (!mapping || !id) return null;
    try {
      const map = JSON.parse(mapping) as Record<string, string>;
      return map[id] ?? null;
    } catch {
      return null;
    }
  }
}
