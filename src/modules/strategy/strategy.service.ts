import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import {
  ForecastType,
  StrategicActionStatus,
  StrategicActionType,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AiService } from '../ai/ai.service';
import { RagService } from '../ai/rag.service';
import { WhatsappService } from '../whatsapp/whatsapp.service';

type ActionPayload = {
  message: string;
  customers: Array<{ id: string; name: string; phone?: string | null }>;
  product?: { id: string; name: string; price: number; cost: number; maxDiscountPct: number };
};

type MarketOpportunityPayload = ActionPayload & {
  competitor?: { id: string; name: string; price: number };
  note?: string;
};

@Injectable()
export class StrategyService {
  private readonly logger = new Logger(StrategyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly aiService: AiService,
    private readonly ragService: RagService,
    private readonly whatsappService: WhatsappService,
  ) {}

  async suggestRevenueRecoveryPlan(companyId: string, dropPercent: number) {
    const recent = await this.prisma.strategicAction.findFirst({
      where: {
        companyId,
        type: StrategicActionType.MARKETING,
        status: StrategicActionStatus.SUGGESTED,
        createdAt: { gte: this.addHours(new Date(), -12) },
      },
    });
    if (recent) return recent;

    const { topProduct, topCustomers } = await this.pickTopAssets(companyId);
    const maxDiscountPct = this.safeDiscountPct(topProduct?.price, topProduct?.cost);

    const context = await this.buildContext(companyId, {
      dropPercent,
      product: topProduct,
      customers: topCustomers,
      maxDiscountPct,
    });

    const prompt = [
      'Gere um plano de ação curto para recuperar receita nas próximas 2 semanas.',
      `Queda prevista: ${dropPercent.toFixed(1)}%.`,
      'Formato: titulo; descricao markdown de 3 bullets; desconto proposto (<= maxDiscountPct); CTA via WhatsApp.',
      `maxDiscountPct=${maxDiscountPct.toFixed(1)}% (não ultrapasse; nunca sugerir prejuízo).`,
      `Produto foco: ${topProduct ? topProduct.name : 'melhor produto disponível'}.`,
      'Retorne somente texto plano, sem JSON.',
    ].join('\n');

    let title = 'Campanha de recuperação de receita';
    let description = '- Enviar oferta segmentada\n- Destacar produto campeão\n- Criar senso de urgência';
    let message =
      'Olá {{nome}}, preparamos uma oferta especial para você nas próximas 48h. Responda para garantir.';

    try {
      const rag = await this.ragService.buildContext(companyId, prompt);
      const result = await this.aiService['generateText'](`${rag}\n\n${prompt}`);
      const text = result.text || '';
      title = text.split('\n')[0]?.trim() || title;
      description = text;
      if (text.includes('%')) {
        const match = text.match(/([0-9]{1,2})%/);
        const pct = match ? Number(match[1]) : maxDiscountPct;
        const capped = Math.min(maxDiscountPct, pct || maxDiscountPct);
        message = `Olá {{nome}}, liberamos um desconto de até ${capped.toFixed(
          0,
        )}% no ${topProduct?.name ?? 'seu produto favorito'} pelas próximas 48h. Responda para receber o link exclusivo.`;
      }
    } catch (error) {
      this.logger.warn(
        `IA indisponível, usando plano padrão: ${(error as Error)?.message}`,
      );
    }

    const payload: ActionPayload = {
      message,
      customers: topCustomers,
      product: topProduct
        ? {
            ...topProduct,
            maxDiscountPct,
          }
        : undefined,
    };

    return this.prisma.strategicAction.create({
      data: {
        companyId,
        title,
        description,
        type: StrategicActionType.MARKETING,
        status: StrategicActionStatus.SUGGESTED,
        impactScore: Math.min(100, Math.max(40, Math.round(dropPercent * 2))),
        payload,
      },
    });
  }

  async listActions(
    userId: string,
    status: StrategicActionStatus = StrategicActionStatus.SUGGESTED,
    companyId?: string | null,
  ) {
    const company = await this.resolveCompany(userId, companyId);
    return this.prisma.strategicAction.findMany({
      where: { companyId: company.id, status },
      orderBy: { createdAt: 'desc' },
    });
  }

  async approveAndExecute(
    userId: string,
    actionId: string,
    companyId?: string | null,
  ) {
    const action = await this.getActionForCompany(userId, actionId, companyId);
    if (action.status === StrategicActionStatus.EXECUTED) return action;

    const payload = action.payload as ActionPayload | undefined;
    if (action.type === StrategicActionType.MARKETING && payload?.customers?.length) {
      await this.executeMarketingAction(action.companyId, payload);
    }

    return this.prisma.strategicAction.update({
      where: { id: action.id },
      data: { status: StrategicActionStatus.EXECUTED },
    });
  }

  async suggestMarketOpportunity(
    companyId: string,
    data: {
      product: { id: string; name: string; price: number };
      competitor: { id: string; name: string; price: number };
      reason: string;
    },
  ) {
    const recent = await this.prisma.strategicAction.findFirst({
      where: {
        companyId,
        type: StrategicActionType.ESTOQUE,
        createdAt: { gte: this.addHours(new Date(), -24) },
        title: { contains: data.competitor.name },
      },
    });
    if (recent) return recent;

    const payload: MarketOpportunityPayload = {
      message:
        'Oportunidade: Concorrente estÃ¡ sem estoque ou aumentou o preÃ§o. Podemos manter nosso preÃ§o e destacar entrega rÃ¡pida no WhatsApp.',
      customers: [],
      competitor: data.competitor,
      product: {
        id: data.product.id,
        name: data.product.name,
        price: data.product.price,
        cost: data.product.price,
        maxDiscountPct: 0,
      },
      note: data.reason,
    };

    return this.prisma.strategicAction.create({
      data: {
        companyId,
        title: `Oportunidade: ${data.competitor.name} subiu o preÃ§o`,
        description: `${data.reason}\nProduto: ${data.product.name}\nConcorrente: ${data.competitor.name} (R$ ${data.competitor.price.toFixed(
          2,
        )})`,
        type: StrategicActionType.ESTOQUE,
        status: StrategicActionStatus.SUGGESTED,
        impactScore: 70,
        payload,
      },
    });
  }

  private async executeMarketingAction(companyId: string, payload: ActionPayload) {
    const toSend = payload.customers.filter((c) => c.phone);
    for (const customer of toSend) {
      const personalized = payload.message.replace('{{nome}}', customer.name || 'cliente');
      try {
        await this.whatsappService.sendTextMessage(companyId, customer.phone!, personalized);
      } catch (error) {
        this.logger.warn(
          `Falha ao enviar WhatsApp para ${customer.phone}: ${(error as Error)?.message}`,
        );
      }
    }
  }

  private async getActionForCompany(
    userId: string,
    actionId: string,
    companyId?: string | null,
  ) {
    const company = await this.resolveCompany(userId, companyId);
    const action = await this.prisma.strategicAction.findFirst({
      where: { id: actionId, companyId: company.id },
    });
    if (!action) {
      throw new BadRequestException('Action nao encontrada para esta empresa');
    }
    return action;
  }

  private async pickTopAssets(companyId: string) {
    const [product] = await this.prisma.product.findMany({
      where: { companyId },
      orderBy: [{ price: 'desc' }],
      take: 1,
      select: { id: true, name: true, price: true, cost: true },
    });

    const customers = await this.prisma.customer.findMany({
      where: { companyId, phone: { not: null } },
      orderBy: { createdAt: 'asc' },
      take: 50,
      select: { id: true, name: true, phone: true },
    });

    return {
      topProduct: product
        ? {
            id: product.id,
            name: product.name,
            price: Number(product.price),
            cost: Number(product.cost ?? 0),
          }
        : undefined,
      topCustomers: customers,
    };
  }

  private safeDiscountPct(price?: number, cost?: number): number {
    const p = Number(price ?? 0);
    const c = Number(cost ?? 0);
    if (!p || p <= c) return 0;
    const maxPct = ((p - c) / p) * 100;
    return Math.max(0, Math.min(30, maxPct)); // cap at 30% for safety
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
      select: { id: true },
    });
    if (!company) {
      throw new BadRequestException('Empresa invalida');
    }
    return company;
  }

  private async buildContext(companyId: string, data: Record<string, unknown>) {
    const formatted = JSON.stringify(data);
    return `Contexto estruturado para plano de ação: ${formatted}.`;
  }

  private addHours(date: Date, hours: number) {
    const d = new Date(date);
    d.setHours(d.getHours() + hours);
    return d;
  }
}
