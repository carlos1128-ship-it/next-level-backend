/**
 * =============================================================================
 * WHATSAPP SERVICE — Estabilidade Avançada para Render.com
 * Multi-tenant + BullMQ + Neon Persistence + Erro Handling Resiliente
 * =============================================================================
 */

import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  OnApplicationShutdown,
} from '@nestjs/common';
import {
  create,
  Whatsapp as WhatsappClient,
} from '@wppconnect-team/wppconnect';
import type {
  SessionToken,
  TokenStore,
} from '@wppconnect-team/wppconnect/dist/token-store/types';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../../prisma/prisma.service';

// ─── Tipagens e Constantes ───────────────────────────────────────────────────

export type WhatsappStatus = 
  | 'DISCONNECTED' 
  | 'CONNECTING' 
  | 'QR_READY' 
  | 'AUTHENTICATING' 
  | 'CONNECTED' 
  | 'UNPAIRED';

const SESSION_BASE_DIR = '/tmp/.wppconnect';
const WHATSAPP_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

// ─── NeonTokenStore ───────────────────────────────────────────────────────────

class NeonTokenStore implements TokenStore {
  constructor(
    private readonly prisma: PrismaService,
    private readonly companyId: string,
    private readonly logger: Logger,
  ) {}

  async getToken(_sessionName: string): Promise<SessionToken | undefined> {
    try {
      const company = await this.prisma.company.findUnique({
        where: { id: this.companyId },
        select: { whatsappSessionToken: true } as any,
      });

      if (!(company as any)?.whatsappSessionToken) return undefined;
      return JSON.parse((company as any).whatsappSessionToken) as SessionToken;
    } catch (err) {
      this.logger.error(`[WA-TOKEN][${this.companyId}] Falha ao ler token: ${err}`);
      return undefined;
    }
  }

  async setToken(_sessionName: string, tokenData: SessionToken | null): Promise<boolean> {
    try {
      await this.prisma.company.update({
        where: { id: this.companyId },
        data: { whatsappSessionToken: tokenData ? JSON.stringify(tokenData) : null } as any,
      });
      return true;
    } catch {
      return false;
    }
  }

  async removeToken(_sessionName: string): Promise<boolean> {
    try {
      await this.prisma.company.update({
        where: { id: this.companyId },
        data: { whatsappSessionToken: null } as any,
      });
      return true;
    } catch {
      return false;
    }
  }

  async listTokens(): Promise<string[]> {
    return [`company-${this.companyId}`];
  }
}

// ─── Service ──────────────────────────────────────────────────────────────────

@Injectable()
export class WhatsappService implements OnModuleInit, OnModuleDestroy, OnApplicationShutdown {
  private readonly logger = new Logger(WhatsappService.name);
  private readonly clients = new Map<string, WhatsappClient>();
  private readonly initializations = new Map<string, Promise<WhatsappClient | null>>();
  private readonly qrCodes = new Map<string, string>();
  private readonly statuses = new Map<string, WhatsappStatus>();

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue('whatsapp-queue') private readonly whatsappQueue: Queue,
  ) {}

  async onModuleInit() {
    this.logger.log('Recuperando sessões ativas do WhatsApp...');
    try {
      const activeCompanies = await (this.prisma.company as any).findMany({
        where: { whatsappStatus: 'CONNECTED' },
        select: { id: true },
      });

      for (const { id } of activeCompanies) {
        this.createSession(id).catch(err => 
          this.logger.warn(`Falha na recuperação da sessão ${id}: ${err.message}`)
        );
      }
    } catch (err) {
      this.logger.error(`Erro ao listar empresas ativas: ${err.message}`);
    }
  }

  async createSession(companyId: string) {
    if (this.clients.has(companyId)) {
      return { status: 'CONNECTED', qrCode: undefined };
    }

    if (this.initializations.has(companyId)) {
      return { 
        status: this.statuses.get(companyId) || 'CONNECTING', 
        qrCode: this.qrCodes.get(companyId) 
      };
    }

    this.statuses.set(companyId, 'CONNECTING');
    this.initializations.set(companyId, this.bootstrapClient(companyId));

    return { status: 'CONNECTING' };
  }

  async terminateSession(companyId: string): Promise<boolean> {
    const client = this.clients.get(companyId);
    
    try {
      if (client) {
        // Envolve em try/catch para ignorar ProtocolErrors se o browser já fechou
        await client.logout().catch(() => null);
        await client.close().catch((err) => {
          if (!err.message.includes('Target already closed')) {
            this.logger.warn(`[WA-CLOSE][${companyId}] Erro ao fechar: ${err.message}`);
          }
        });
      }
      
      this.cleanupMemory(companyId);
      
      await (this.prisma.company as any).update({
        where: { id: companyId },
        data: { whatsappStatus: 'DISCONNECTED' },
      }).catch(() => null);

      return true;
    } catch (error) {
      this.logger.error(`Erro ao encerrar sessão ${companyId}: ${error.message}`);
      return false;
    }
  }

  getStatus(companyId: string): WhatsappStatus {
    return this.statuses.get(companyId) || 'DISCONNECTED';
  }

  async sendTextMessage(companyId: string, externalId: string, message: string) {
    const status = this.getStatus(companyId);
    if (status !== 'CONNECTED') {
      throw new BadRequestException(`WhatsApp não conectado para empresa ${companyId}`);
    }

    try {
      const job = await this.whatsappQueue.add('sendAutoReply', {
        companyId,
        from: externalId,
        message,
      }, {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        priority: 1
      });

      return { success: true, messageId: job.id?.toString() };
    } catch (error) {
      this.logger.error(`Falha ao enfileirar mensagem para ${companyId}: ${error.message}`);
      throw new InternalServerErrorException('Falha ao processar envio de mensagem');
    }
  }

  // ─── Lógica de Engine (Privada) ─────────────────────────────────────────────

  private async bootstrapClient(companyId: string): Promise<WhatsappClient | null> {
    const neonStore = new NeonTokenStore(this.prisma, companyId, this.logger);

    try {
      this.logger.log(`[WA-INIT][${companyId}] Inicializando motor WPPConnect...`);
      
      const client = await (create as any)({
        session: `company-${companyId}`,
        tokenStore: neonStore,
        headless: 'new', // Recomendado para versões recentes do Puppeteer
        logQR: false,
        updatesLog: false,
        autoClose: 0,    // PATCH: Desabilitado para evitar "Auto Close Called" fatal
        waitForLogin: true,
        disableWelcome: true,
        folderNameToken: SESSION_BASE_DIR,
        waVersion: '2.2412.54',
        catchQR: (base64Qr: string) => {
          const uri = base64Qr.startsWith('data:') ? base64Qr : `data:image/png;base64,${base64Qr}`;
          this.qrCodes.set(companyId, uri);
          this.statuses.set(companyId, 'QR_READY');
        },
        statusFind: (statusSession: string) => {
          this.handleStatusChange(companyId, statusSession);
        },
        puppeteerOptions: {
          executablePath: process.env.CHROME_PATH || undefined, 
          args: [
            `--user-agent=${WHATSAPP_USER_AGENT}`,
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--no-zygote',
            '--single-process',
            '--disable-extensions',
          ],
        },
      } as any);

      this.clients.set(companyId, client);
      this.initializations.delete(companyId);
      this.qrCodes.delete(companyId);
      
      this.setupMessageListener(client, companyId);
      
      return client;
    } catch (error) {
      const msg = error.message;
      
      // PATCH: Silencia erros de fechamento automático ou protocolo do Puppeteer
      if (msg.includes('Auto Close Called') || msg.includes('Target.closeTarget')) {
        this.logger.warn(`[WA-INIT-RESET][${companyId}] Inicialização interrompida: ${msg}. Tentando resetar...`);
        this.handleRetry(companyId);
        return null;
      }

      this.logger.error(`[WA-FATAL][${companyId}] Falha na inicialização: ${msg}`);
      this.statuses.set(companyId, 'DISCONNECTED');
      this.initializations.delete(companyId);
      this.cleanupMemory(companyId);
      return null;
    }
  }

  private handleStatusChange(companyId: string, status: string) {
    this.logger.log(`[WA-STATUS][${companyId}] ${status}`);

    switch (status) {
      case 'isLogged':
      case 'qrReadSuccess':
      case 'chatsAvailable':
        this.statuses.set(companyId, 'CONNECTED');
        break;
      case 'notLogged':
        this.statuses.set(companyId, 'QR_READY');
        break;
      case 'autocloseCalled':
      case 'qrReadError':
      case 'disconnectedMobile':
        this.logger.warn(`[WA-RETRY][${companyId}] Estado crítico detectado: ${status}. Reiniciando em 10s...`);
        this.handleRetry(companyId);
        break;
      case 'connecting':
      case 'browserClose':
        this.statuses.set(companyId, 'CONNECTING');
        break;
      default:
        this.statuses.set(companyId, 'DISCONNECTED');
    }

    // Persiste status no banco se conectado
    if (this.statuses.get(companyId) === 'CONNECTED') {
      (this.prisma.company as any).update({
        where: { id: companyId },
        data: { whatsappStatus: 'CONNECTED' },
      }).catch(() => null);
    }
  }

  /**
   * PATCH: Lógica de retry resiliente para evitar Unhandled Rejections
   */
  private handleRetry(companyId: string) {
    this.cleanupMemory(companyId);
    setTimeout(() => {
      this.createSession(companyId).catch(err => 
        this.logger.error(`[WA-RETRY-FAILED][${companyId}] Erro ao reiniciar: ${err.message}`)
      );
    }, 10000); // 10s de intervalo para respiro do container
  }

  private setupMessageListener(client: WhatsappClient, companyId: string) {
    client.onMessage(async (message: any) => {
      if (message.isGroupMsg) return;
      await this.whatsappQueue.add('processIncomingMessage', {
        companyId,
        from: message.from,
        message: message.body,
        name: (message as any).sender?.pushname || (message as any).sender?.name,
      });
    });

    client.onStateChange(async (state) => {
      if ((state as any) === 'CONNECTED') this.statuses.set(companyId, 'CONNECTED');
      if ((state as any) === 'DISCONNECTED') await this.terminateSession(companyId);
    });
  }

  getQrCode(companyId: string) {
    return this.qrCodes.get(companyId);
  }

  private cleanupMemory(companyId: string) {
    this.clients.delete(companyId);
    this.initializations.delete(companyId);
    this.qrCodes.delete(companyId);
    this.statuses.delete(companyId);
  }

  async onModuleDestroy() { await this.shutdownAll(); }
  async onApplicationShutdown() { await this.shutdownAll(); }

  private async shutdownAll() {
    this.logger.log('Encerrando instâncias do WhatsApp...');
    for (const [id, client] of this.clients.entries()) {
      try {
        await client.close();
      } catch {
        // Ignora erros no shutdown
      }
    }
  }
}
