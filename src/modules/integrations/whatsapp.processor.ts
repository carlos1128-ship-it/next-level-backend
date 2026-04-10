import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { PrismaService } from '../../prisma/prisma.service';
import { ChatService } from '../ai/chat.service';

@Processor('whatsapp-queue')
export class WhatsappProcessor extends WorkerHost {
  private readonly logger = new Logger(WhatsappProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly chatService: ChatService,
  ) {
    super();
  }

  async process(job: Job<any, any, string>): Promise<any> {
    const { companyId, message, from, name } = job.data;

    switch (job.name) {
      case 'processIncomingMessage':
        return this.handleIncomingMessage(companyId, message, from, name);
      case 'syncToDashboard':
        return this.handleSyncToDashboard(companyId, message, from);
      case 'sendAutoReply':
        return this.handleAutoReply(companyId, message, from);
      default:
        this.logger.warn(`Job desconhecido: ${job.name}`);
    }
  }

  private async handleIncomingMessage(companyId: string, text: string, from: string, name: string) {
    this.logger.log(`[PROCESS][${companyId}] Mensagem de ${from}: ${text.substring(0, 50)}...`);
    
    // 1. Persistir log da mensagem
    // Implementar log de interações se necessário

    // 2. Extrair dados de venda/leads (Pode usar IA para classificar)
    // Se a mensagem contiver termos de compra, agendar sync
  }

  private async handleSyncToDashboard(companyId: string, text: string, from: string) {
    this.logger.log(`[SYNC][${companyId}] Sincronizando métricas para ${from}`);
    // Atualizar estatísticas da empresa no Dashboard
  }

  private async handleAutoReply(companyId: string, text: string, from: string) {
    try {
      const company = await this.prisma.company.findUnique({
        where: { id: companyId },
        select: { userId: true },
      });

      if (!company?.userId) return;

      const aiResponse = await this.chatService.chat(company.userId, {
        companyId,
        message: text,
      });

      if (aiResponse.response) {
        // O disparo real será feito pelo service via evento ou injeção
        // Para evitar circularidade, o processor pode emitir um evento que o service escuta
        return { response: aiResponse.response, to: from };
      }
    } catch (error) {
      this.logger.error(`[AI-ERROR][${companyId}] Falha na resposta automática: ${error.message}`);
      throw error;
    }
  }
}
