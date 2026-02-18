import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Prisma, SaleChannel } from '@prisma/client';

interface ShopifyOrder {
  id?: number | string;
  order_number?: number;
  total_price?: string;
  created_at?: string;
  line_items?: Array<{ title?: string; quantity?: number }>;
  note_attributes?: Array<{ name: string; value: string }>;
}

/**
 * Processa webhooks do Shopify e persiste vendas.
 * Inserção de vendas: mesmo modelo Sale (channel = 'shopify', occurredAt do pedido).
 * Ver SalesService: comentário onde webhooks irão inserir vendas.
 */
@Injectable()
export class WebhooksShopifyService {
  constructor(private readonly prisma: PrismaService) {}

  async processWebhook(payload: Record<string, unknown>) {
    const topic = payload['x-shopify-topic'] ?? payload['topic'] as string | undefined;
    const order = (payload.order ?? payload) as ShopifyOrder;

    if (topic === 'orders/create' || topic === 'orders/updated' || !topic) {
      return this.syncOrder(order);
    }

    return { received: true, topic };
  }

  private async syncOrder(order: ShopifyOrder) {
    const companyId = this.resolveCompanyId(order);
    if (!companyId) {
      return { received: true, skipped: 'company_id não encontrado no pedido' };
    }

    const occurredAt = order.created_at ? new Date(order.created_at) : new Date();
    const amount = parseFloat(order.total_price ?? '0') || 0;
    const productName = order.line_items?.[0]?.title ?? 'Pedido Shopify';

    await this.prisma.sale.create({
      data: {
        companyId,
        amount: new Prisma.Decimal(amount),
        productName,
        channel: SaleChannel.shopify,
        occurredAt,
      },
    });

    return { received: true, synced: true };
  }

  private resolveCompanyId(order: ShopifyOrder): string | null {
    const attr = order.note_attributes?.find((a) => a.name === 'company_id');
    return (attr?.value as string) ?? null;
  }
}
