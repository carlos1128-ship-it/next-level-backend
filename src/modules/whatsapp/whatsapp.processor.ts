import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Job } from 'bullmq';
import { WhatsappService } from './whatsapp.service';

@Processor('whatsapp-queue')
export class WhatsappProcessor extends WorkerHost {
  private readonly logger = new Logger(WhatsappProcessor.name);

  constructor(
    private readonly moduleRef: ModuleRef,
    private readonly eventEmitter: EventEmitter2,
  ) {
    super();
  }

  async process(job: Job<any, any, string>): Promise<any> {
    const { companyId, message, from, name } = job.data;

    switch (job.name) {
      case 'processIncomingMessage':
        return this.handleIncomingMessage(companyId, message, from, name);
      case 'sendText':
        return this.handleSendText(job);
      case 'sendBulkMessage':
        return this.handleBulkMessage(job);
      default:
        this.logger.warn(`Job desconhecido: ${job.name}`);
        return null;
    }
  }

  private async handleIncomingMessage(companyId: string, text: string, from: string, name: string) {
    this.logger.log(`[PROCESS][${companyId}] Mensagem de ${from}: ${text.substring(0, 50)}...`);

    await this.eventEmitter.emitAsync('whatsapp.message.received', {
      companyId,
      from,
      text,
      name,
    });

    return { delivered: true };
  }

  private async handleSendText(job: Job<any, any, string>) {
    const { companyId, to, message } = job.data as {
      companyId: string;
      to: string;
      message: string;
    };

    const client = this.getClient(companyId);
    const target = this.normalizeRecipient(to);

    await client.sendText(target, message);
    this.logger.log(`[SEND][${companyId}] Mensagem enviada para ${target}`);
    return { success: true, to: target };
  }

  private async handleBulkMessage(job: Job<any, any, string>) {
    const { companyId, phoneNumber, message } = job.data as {
      companyId: string;
      phoneNumber: string;
      message: string;
    };

    const client = this.getClient(companyId);
    const target = this.normalizeRecipient(phoneNumber);

    await client.sendText(target, message);
    this.logger.log(`[BULK][${companyId}] Mensagem enviada para ${target}`);
    return { success: true, to: target };
  }

  private getClient(companyId: string) {
    const whatsappService = this.moduleRef.get(WhatsappService, { strict: false });
    const client = whatsappService?.getClient(companyId);

    if (!client) {
      throw new Error(`WhatsApp não conectado para ${companyId}`);
    }

    return client;
  }

  private normalizeRecipient(recipient: string) {
    const rawRecipient = String(recipient || '').trim();
    return rawRecipient.includes('@')
      ? rawRecipient
      : `${rawRecipient.replace(/\D/g, '')}@c.us`;
  }
}
