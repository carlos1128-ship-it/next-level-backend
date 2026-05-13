import { Injectable } from '@nestjs/common';
import { AttendantIntent } from './attendant-action.types';

@Injectable()
export class AttendantIntentService {
  detectIntent(text: string): AttendantIntent {
    const normalized = this.normalize(text);

    if (this.matches(normalized, ['humano', 'atendente', 'pessoa real', 'falar com alguem'])) {
      return 'HUMAN_HANDOFF';
    }

    if (this.matches(normalized, ['cancelar', 'cancelamento', 'desistir', 'nao quero mais', 'estornar'])) {
      return 'CANCELLATION_REQUEST';
    }

    if (this.matches(normalized, ['suporte', 'problema', 'erro', 'reclamacao', 'nao funciona', 'ajuda'])) {
      return 'SUPPORT_REQUEST';
    }

    if (this.matches(normalized, ['renovar', 'upgrade', 'plano maior', 'mais usuarios', 'aumentar pacote'])) {
      return 'UPSELL_RENEWAL_OPPORTUNITY';
    }

    if (this.matches(normalized, ['assinatura fechada', 'contrato fechado', 'fechamos a assinatura', 'plano fechado'])) {
      return 'SUBSCRIPTION_CLOSED';
    }

    if (
      this.matches(normalized, [
        'pagamento confirmado',
        'pagamento aprovado',
        'pix enviado',
        'pix pago',
        'paguei',
        'venda fechada',
        'pedido fechado',
        'compra finalizada',
        'fechei a compra',
        'pode fechar',
        'vou ficar com',
      ])
    ) {
      return 'SALE_COMPLETED';
    }

    if (this.matches(normalized, ['vou pagar', 'posso pagar', 'link de pagamento', 'manda o pix', 'chave pix'])) {
      return 'PAYMENT_INTENTION';
    }

    if (this.matches(normalized, ['reuniao', 'reunir', 'call', 'chamada', 'mentoria'])) {
      return 'MEETING_REQUEST';
    }

    if (
      this.matches(normalized, [
        'marcar',
        'agendar',
        'agenda',
        'horario',
        'consulta',
        'reuniao',
        'reservar',
        'reserva',
      ])
    ) {
      return 'SCHEDULE_REQUEST';
    }

    if (this.matches(normalized, ['orcamento', 'cotacao', 'proposta', 'valores', 'preco', 'quanto custa'])) {
      return 'QUOTE_REQUEST';
    }

    if (this.matches(normalized, ['comprar', 'quero comprar', 'tenho interesse', 'contratar', 'fechar'])) {
      return 'PRODUCT_INTEREST';
    }

    if (this.matches(normalized, ['pedido de', 'quero pedir', 'encomendar', 'separar para mim'])) {
      return 'ORDER_PLACED';
    }

    if (this.matches(normalized, ['consultoria', 'avaliacao', 'atendimento', 'visita', 'servico', 'serviço'])) {
      return 'SERVICE_REQUEST';
    }

    if (this.matches(normalized, ['meu nome', 'me chamo', 'telefone', 'whatsapp', 'email'])) {
      return 'CUSTOMER_DATA_CAPTURE';
    }

    if (this.matches(normalized, ['saber mais', 'informacao', 'informacoes', 'como funciona', 'fazem', 'atendem'])) {
      return 'SERVICE_INFORMATION';
    }

    return normalized.trim() ? 'GENERAL_QUESTION' : 'UNKNOWN';
  }

  private matches(text: string, terms: string[]) {
    return terms.some((term) => text.includes(term));
  }

  private normalize(text: string) {
    return text
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
  }
}
