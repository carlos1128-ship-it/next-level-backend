import { Injectable } from '@nestjs/common';
import { AttendantIntent } from './attendant-action.types';

@Injectable()
export class AttendantIntentService {
  detectIntent(text: string): AttendantIntent {
    const normalized = this.normalize(text);

    if (this.matches(normalized, ['humano', 'atendente', 'pessoa real', 'falar com alguem'])) {
      return 'HUMAN_HANDOFF';
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
