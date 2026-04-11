import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { Job } from 'bullmq';
import { PrismaService } from '../../prisma/prisma.service';
import { ChatService } from '../ai/chat.service';
import { WhatsappService } from './whatsapp.service';

@Processor('whatsapp-queue')
export class WhatsappProcessor extends WorkerHost {
  private readonly logger = new Logger(WhatsappProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly chatService: ChatService,
    private readonly moduleRef: ModuleRef,
  ) {
    super();
  }

  async process(job: Job<any, any, string>): Promise<any> {
    const { companyId, message, from, name } = job.data;

    switch (job.name) {
      case 'processIncomingMessage':
        return this.handleIncomingMessage(companyId, message, from, name);
      case 'sendAutoReply':
        return this.handleAutoReply(companyId, message, from);
      case 'sendBulkMessage':
        return this.handleBulkMessage(job);
      default:
        this.logger.warn(`Job desconhecido: ${job.name}`);
    }
  }

  private async handleIncomingMessage(companyId: string, text: string, from: string, name: string) {
    this.logger.log(`[PROCESS][${companyId}] Mensagem de ${from}: ${text.substring(0, 50)}...`);
    // Lógica para repassar para o AttendantService se necessário (via EventEmitter)
  }

  private async handleAutoReply(companyId: string, text: string, from: string) {
    try {
      const company = await this.prisma.company.findUnique({
        where: { id: companyId },
        select: { userId: true },
      });

      if (!(company as any)?.userId) return;

      const aiResponse = await this.chatService.chat((company as any).userId, {
        companyId,
        message: text,
      });

      if (aiResponse.response) {
        // Nota: O disparo real de volta para o WhatsappService deve ser feito via Evento ou Injeção circular
        this.logger.log(`[AI-REPLY][${companyId}] Resposta gerada para ${from}`);
        return { response: aiResponse.response, to: from };
      }
    } catch (error) {
      this.logger.error(`[AI-ERROR][${companyId}] Falha na resposta automática: ${error.message}`);
      throw error;
    }
  }

  private async handleBulkMessage(job: Job<any, any, string>) {
    const { companyId, phoneNumber, message } = job.data as {
      companyId: string;
      phoneNumber: string;
      message: string;
    };

    const whatsappService = this.moduleRef.get(WhatsappService, { strict: false });
    const client = whatsappService?.getClient(companyId);

    if (!client) {
      throw new Error(`WhatsApp não conectado para ${companyId}`);
    }

    const rawPhone = String(phoneNumber || '').trim();
    const sanitized = rawPhone.replace(/\D/g, '');
    const target = rawPhone.includes('@') ? rawPhone : `${sanitized}@c.us`;

    await client.sendText(target, message);
    this.logger.log(`[BULK][${companyId}] Mensagem enviada para ${phoneNumber}`);
    return { success: true, to: target };
  }
}
