import { Injectable } from '@nestjs/common';
import { ExtractedAttendantFields } from './attendant-action.types';

@Injectable()
export class AttendantDataExtractionService {
  extract(text: string, now = new Date()): ExtractedAttendantFields {
    const compact = text.replace(/\s+/g, ' ').trim();

    return {
      customerName: this.extractName(compact),
      phone: this.extractPhone(compact),
      email: this.extractEmail(compact),
      desiredDate: this.extractDate(compact, now),
      desiredTime: this.extractTime(compact),
      requestedService: this.extractService(compact),
      objective: this.extractObjective(compact),
      preferredContactMethod: this.extractPreferredContact(compact),
      urgency: this.extractUrgency(compact),
      budget: this.extractBudget(compact),
      notes: compact || null,
    };
  }

  missingForIntent(intent: string, fields: ExtractedAttendantFields) {
    const missing: string[] = [];

    if (this.isLeadIntent(intent) && !fields.customerName) {
      missing.push('customerName');
    }
    if (this.isLeadIntent(intent) && !fields.phone && !fields.email) {
      missing.push('phone');
    }
    if (this.requiresInterest(intent) && !fields.requestedService && !fields.objective) {
      missing.push('requestedService');
    }

    if (['SCHEDULE_REQUEST', 'MEETING_REQUEST'].includes(intent)) {
      if (!fields.desiredDate) {
        missing.push('desiredDate');
      }
      if (!fields.desiredTime) {
        missing.push('desiredTime');
      }
    }

    return missing;
  }

  private extractName(text: string) {
    const explicitMatch = text.match(/\b(?:meu nome e|me chamo|sou)\s+([\p{L}]+(?:\s+[\p{L}]+){0,5})(?=\s+(?:e\s+)?(?:meu\s+)?(?:telefone|whatsapp|email|e-mail)|[,.;]|$)/iu);
    const explicit =
      explicitMatch?.[1]
        ?.replace(/\s+e\s+meu$/i, '')
        .replace(/\s+e$/i, '')
        .trim() || null;
    return explicit || this.extractLooseName(text);
  }

  private extractPhone(text: string) {
    const match = text.match(/(?:\+?55\s?)?(?:\(?\d{2}\)?\s?)?\d{4,5}[-\s]?\d{4}/);
    return match?.[0]?.replace(/[^\d+]/g, '') || null;
  }

  private extractEmail(text: string) {
    const match = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    return match?.[0]?.trim() || null;
  }

  private extractDate(text: string, now: Date) {
    const normalized = this.normalize(text);

    if (normalized.includes('depois de amanha')) {
      return this.toDateOnly(this.addDays(now, 2));
    }

    if (normalized.includes('amanha')) {
      return this.toDateOnly(this.addDays(now, 1));
    }

    if (normalized.includes('hoje')) {
      return this.toDateOnly(now);
    }

    const dateMatch = text.match(/\b(\d{1,2})[\/.-](\d{1,2})(?:[\/.-](\d{2,4}))?\b/);
    if (!dateMatch) {
      return null;
    }

    const day = Number(dateMatch[1]);
    const month = Number(dateMatch[2]);
    const currentYear = now.getFullYear();
    const rawYear = dateMatch[3] ? Number(dateMatch[3]) : currentYear;
    const year = rawYear < 100 ? 2000 + rawYear : rawYear;
    const candidate = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));

    if (Number.isNaN(candidate.getTime())) {
      return null;
    }

    return this.toDateOnly(candidate);
  }

  private extractTime(text: string) {
    const normalized = this.normalize(text);
    if (this.hasAmbiguousTime(normalized)) {
      return null;
    }

    const match = text.match(/\b(?:as|a)?\s*(\d{1,2})(?::|h)?(\d{2})?\s*(?:h|horas)?\b/i);
    if (match) {
      let hour = Number(match[1]);
      const minutes = match[2] ? Number(match[2]) : 0;
      if (hour >= 1 && hour <= 11 && /(da tarde|a tarde|pela tarde|da noite|a noite)/.test(normalized)) {
        hour += 12;
      }
      if (hour < 0 || hour > 23 || minutes < 0 || minutes > 59) {
        return null;
      }

      return `${String(hour).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
    }

    const wordHour = this.extractWrittenHour(normalized);
    if (wordHour === null) {
      return null;
    }

    let hour = wordHour;
    if (hour >= 1 && hour <= 11 && /(da tarde|a tarde|pela tarde|da noite|a noite)/.test(normalized)) {
      hour += 12;
    }
    if (hour < 0 || hour > 23) {
      return null;
    }

    return `${String(hour).padStart(2, '0')}:00`;
  }

  private extractService(text: string) {
    const match = text.match(/\b(?:consulta|reuniao|avaliacao|procedimento|servico|consultoria|visita|aula|curso|mentoria|corte|barba|tratamento|orcamento)\b(?:\s+(?:de|para|sobre)\s+([^,.!?]+))?/i);
    if (!match) {
      return null;
    }

    return (match[1] || match[0]).trim();
  }

  private extractObjective(text: string) {
    const match = text.match(/\b(?:quero|preciso|tenho interesse em|gostaria de|pode me ajudar com)\s+([^.!?]{3,120})/i);
    const objective = match?.[1]?.trim() || null;
    if (!objective) {
      return null;
    }
    const normalized = this.normalize(objective);
    if (/^(marcar|agendar|reservar)\s+(um\s+|uma\s+)?(horario|consulta|atendimento)$/.test(normalized)) {
      return null;
    }
    return objective;
  }

  private extractPreferredContact(text: string) {
    const normalized = this.normalize(text);
    if (normalized.includes('whatsapp')) return 'whatsapp';
    if (normalized.includes('email') || normalized.includes('e-mail')) return 'email';
    if (normalized.includes('ligar') || normalized.includes('telefone')) return 'phone';
    return null;
  }

  private extractUrgency(text: string) {
    const normalized = this.normalize(text);
    if (normalized.includes('urgente') || normalized.includes('hoje')) return 'alta';
    if (normalized.includes('sem pressa')) return 'baixa';
    return null;
  }

  private extractBudget(text: string) {
    const currency = text.match(/r\$\s*\d{2,}(?:[.,]\d{2})?/i);
    if (currency) {
      return currency[0].trim();
    }

    const contextual = text.match(/\b(?:orcamento|budget|investir|investimento|verba)\D{0,20}(\d{2,}(?:[.,]\d{2})?)/i);
    return contextual?.[1]?.trim() || null;
  }

  private hasAmbiguousTime(normalized: string) {
    if (/(qualquer horario|mais tarde|de tarde|pela tarde|a tarde|de manha|pela manha|a noite)/.test(normalized)) {
      return !/(as|a)\s+\d{1,2}|(?:uma|duas|tres|quatro|cinco|seis|sete|oito|nove|dez|onze|doze)\s+(?:da|de|a)?\s*(?:tarde|manha|noite)/.test(normalized);
    }
    return /\b\d{1,2}\s*(?:ou|\/)\s*\d{1,2}\b/.test(normalized);
  }

  private extractWrittenHour(normalized: string) {
    const hours: Record<string, number> = {
      uma: 1,
      duas: 2,
      dois: 2,
      tres: 3,
      quatro: 4,
      cinco: 5,
      seis: 6,
      sete: 7,
      oito: 8,
      nove: 9,
      dez: 10,
      onze: 11,
      doze: 12,
    };
    const match = normalized.match(/\b(uma|duas|dois|tres|quatro|cinco|seis|sete|oito|nove|dez|onze|doze)\b(?:\s+horas?)?/);
    return match ? hours[match[1]] : null;
  }

  private extractLooseName(text: string) {
    const withoutPhone = text
      .replace(/(?:\+?55\s?)?(?:\(?\d{2}\)?\s?)?\d{4,5}[-\s]?\d{4}/g, '')
      .replace(/[,.]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!withoutPhone || /[0-9@]/.test(withoutPhone)) {
      return null;
    }
    const normalized = this.normalize(withoutPhone);
    if (/(quero|consulta|avaliacao|amanha|hoje|horario|marcar|agendar|telefone|email|tarde|manha|noite|para)/.test(normalized)) {
      return null;
    }
    const words = withoutPhone.split(/\s+/).filter(Boolean);
    return words.length >= 2 && words.length <= 6 ? withoutPhone : null;
  }

  private isLeadIntent(intent: string) {
    return [
      'SCHEDULE_REQUEST',
      'MEETING_REQUEST',
      'SERVICE_REQUEST',
      'QUOTE_REQUEST',
      'PRODUCT_INTEREST',
      'CUSTOMER_DATA_CAPTURE',
      'SERVICE_INFORMATION',
      'HUMAN_HANDOFF',
    ].includes(intent);
  }

  private requiresInterest(intent: string) {
    return [
      'SCHEDULE_REQUEST',
      'MEETING_REQUEST',
      'SERVICE_REQUEST',
      'QUOTE_REQUEST',
      'PRODUCT_INTEREST',
      'SERVICE_INFORMATION',
    ].includes(intent);
  }

  private addDays(date: Date, days: number) {
    const next = new Date(date);
    next.setDate(next.getDate() + days);
    return next;
  }

  private toDateOnly(date: Date) {
    return date.toISOString().slice(0, 10);
  }

  private normalize(text: string) {
    return text
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
  }
}
