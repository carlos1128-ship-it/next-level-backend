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
      notes: compact || null,
    };
  }

  missingForSchedule(fields: ExtractedAttendantFields) {
    const missing: string[] = [];
    if (!fields.desiredDate) {
      missing.push('desiredDate');
    }
    if (!fields.desiredTime) {
      missing.push('desiredTime');
    }
    if (!fields.requestedService) {
      missing.push('requestedService');
    }
    return missing;
  }

  private extractName(text: string) {
    const match = text.match(/\b(?:meu nome e|meu nome é|me chamo|sou)\s+([A-Za-zÀ-ÿ\s]{2,60})(?:[,.;]|$)/i);
    return match?.[1]?.trim() || null;
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

    if (normalized.includes('amanha')) {
      return this.toDateOnly(this.addDays(now, 1));
    }

    if (normalized.includes('hoje')) {
      return this.toDateOnly(now);
    }

    if (normalized.includes('depois de amanha')) {
      return this.toDateOnly(this.addDays(now, 2));
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
    const match = text.match(/\b(?:as|às|a)?\s*(\d{1,2})(?::|h)?(\d{2})?\s*(?:h|horas)?\b/i);
    if (!match) {
      return null;
    }

    const hour = Number(match[1]);
    const minutes = match[2] ? Number(match[2]) : 0;
    if (hour < 0 || hour > 23 || minutes < 0 || minutes > 59) {
      return null;
    }

    return `${String(hour).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
  }

  private extractService(text: string) {
    const match = text.match(/\b(?:consulta|reuniao|reunião|avaliacao|avaliação|procedimento|servico|serviço)\b(?:\s+(?:de|para|sobre)\s+([^,.!?]+))?/i);
    if (!match) {
      return null;
    }

    return (match[1] || match[0]).trim();
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
