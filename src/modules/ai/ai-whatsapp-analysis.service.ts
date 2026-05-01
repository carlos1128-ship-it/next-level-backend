import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

type AnalyzeWhatsappInput = {
  conversationId: string;
  message?: string;
  customerId?: string | null;
  metadataJson?: Record<string, unknown>;
};

@Injectable()
export class AiWhatsAppAnalysisService {
  constructor(private readonly prisma: PrismaService) {}

  async analyzeMessage(companyId: string, input: AnalyzeWhatsappInput) {
    const conversation = await this.prisma.conversation.findFirst({
      where: { id: input.conversationId, companyId },
      select: { id: true, contactNumber: true },
    });

    if (!conversation) {
      throw new BadRequestException('Conversa nao encontrada para esta empresa');
    }

    if (input.customerId) {
      const customer = await this.prisma.customer.count({
        where: { id: input.customerId, companyId },
      });
      if (customer === 0) {
        throw new BadRequestException('Cliente nao pertence a empresa atual');
      }
    }

    const text = (input.message || '').toLowerCase();
    const intent = this.detectIntent(text);
    const sentiment = this.detectSentiment(text);
    const buyingIntent = this.detectBuyingIntent(text);
    const objections = this.detectObjections(text);
    const recommendedAction = this.recommendAction(intent, buyingIntent, objections);

    const analysis = await this.prisma.conversationAnalysis.create({
      data: {
        companyId,
        conversationId: conversation.id,
        customerId: input.customerId || null,
        intent,
        sentiment,
        productsMentioned: [],
        objections,
        buyingIntent,
        summary: input.message
          ? `Mensagem analisada: ${input.message.slice(0, 240)}`
          : 'Conversa registrada para analise comercial.',
        recommendedAction,
        metadataJson: input.metadataJson as Prisma.InputJsonObject | undefined,
      },
    });

    await this.prisma.customerSignal.create({
      data: {
        companyId,
        customerId: input.customerId || null,
        source: 'whatsapp',
        signalType: buyingIntent === 'hot' ? 'hot_lead' : intent,
        description: recommendedAction,
        metadataJson: {
          conversationId: conversation.id,
          contactNumber: conversation.contactNumber,
          buyingIntent,
          sentiment,
        },
      },
    });

    return analysis;
  }

  private detectIntent(text: string) {
    if (text.includes('preco') || text.includes('valor') || text.includes('quanto')) return 'price_question';
    if (text.includes('entrega') || text.includes('frete') || text.includes('prazo')) return 'delivery_question';
    if (text.includes('problema') || text.includes('reclama') || text.includes('erro')) return 'support_issue';
    if (text.includes('comprar') || text.includes('pedido') || text.includes('quero')) return 'purchase_intent';
    return 'general_message';
  }

  private detectSentiment(text: string) {
    if (text.includes('ruim') || text.includes('demora') || text.includes('problema')) return 'negative';
    if (text.includes('obrigado') || text.includes('gostei') || text.includes('perfeito')) return 'positive';
    return 'neutral';
  }

  private detectBuyingIntent(text: string) {
    if (text.includes('quero comprar') || text.includes('fechar') || text.includes('pix') || text.includes('cartao')) return 'hot';
    if (text.includes('preco') || text.includes('valor') || text.includes('tem disponivel')) return 'warm';
    return 'cold';
  }

  private detectObjections(text: string) {
    const objections: string[] = [];
    if (text.includes('caro') || text.includes('desconto')) objections.push('price_objection');
    if (text.includes('frete') || text.includes('entrega')) objections.push('delivery_objection');
    if (text.includes('garantia') || text.includes('troca')) objections.push('trust_objection');
    return objections;
  }

  private recommendAction(intent: string, buyingIntent: string, objections: string[]) {
    if (buyingIntent === 'hot') return 'Priorizar atendimento humano ou resposta rapida para fechar venda.';
    if (objections.includes('price_objection')) return 'Responder com valor percebido, prova social e opcao de condicao comercial.';
    if (intent === 'support_issue') return 'Criar atendimento de suporte e acompanhar resolucao para evitar churn.';
    if (intent === 'delivery_question') return 'Responder prazo e condicoes de entrega com clareza.';
    return 'Manter conversa ativa e coletar mais contexto comercial.';
  }
}
