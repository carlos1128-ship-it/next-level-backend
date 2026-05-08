import { Injectable } from '@nestjs/common';
import { AttendantIntent } from './attendant-action.types';

@Injectable()
export class AttendantIntentService {
  detectIntent(text: string): AttendantIntent {
    const normalized = this.normalize(text);

    if (this.matches(normalized, ['humano', 'atendente', 'pessoa real', 'falar com alguem'])) {
      return 'HUMAN_HANDOFF';
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

    if (this.matches(normalized, ['meu nome', 'me chamo', 'telefone', 'whatsapp', 'email'])) {
      return 'CUSTOMER_DATA_CAPTURE';
    }

    if (this.matches(normalized, ['servico', 'servicos', 'fazem', 'atendem', 'funciona'])) {
      return 'SERVICE_INFORMATION';
    }

    if (this.matches(normalized, ['preco', 'valor', 'quanto custa', 'orcamento'])) {
      return 'PRICE_REQUEST';
    }

    if (this.matches(normalized, ['problema', 'reclamacao', 'ruim', 'nao gostei'])) {
      return 'COMPLAINT_OR_PROBLEM';
    }

    if (this.matches(normalized, ['pedido', 'status', 'entrega', 'minha compra'])) {
      return 'ORDER_OR_SERVICE_STATUS';
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
