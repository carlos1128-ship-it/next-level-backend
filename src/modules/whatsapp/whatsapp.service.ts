/**
 * =============================================================================
 * WHATSAPP SERVICE — Multi-tenant + BullMQ + Neon Persistence
 * Optimized for Render.com and Stable WAPI Injection
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
  private readonly initializations = new Map<string, Promise<WhatsappClient>>();
  private readonly qrCodes = new Map<string, string>();
  private readonly statuses = new Map<string, WhatsappStatus>();

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue('whatsapp-queue') private readonly whatsappQueue: Queue,
  ) {}

  /**
   * Inicialização do módulo: Recupera sessões que estavam conectadas
   */
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

  // ─── Métodos Públicos Requeridos ───────────────────────────────────────────

  /**
   * 1. createSession(companyId)
   * Cria ou recupera uma conexão para o tenant
   */
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

  /**
   * 2. terminateSession(companyId)
   * Encerra e limpa recursos da conexão
   */
  async terminateSession(companyId: string): Promise<boolean> {
    const client = this.clients.get(companyId);
    
    try {
      if (client) {
        await client.logout().catch(() => null);
        await client.close().catch(() => null);
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

  /**
   * 3. getStatus(companyId)
   * Retorno síncrono do estado atual
   */
  getStatus(companyId: string): WhatsappStatus {
    return this.statuses.get(companyId) || 'DISCONNECTED';
  }

  /**
   * 4. sendTextMessage(companyId, externalId, message)
   * Envia via fila BullMQ para garantir entrega e proteção contra bans
   */
  async sendTextMessage(companyId: string, externalId: string, message: string) {
    const status = this.getStatus(companyId);
    if (status !== 'CONNECTED') {
      throw new BadRequestException(`WhatsApp não conectado para empresa ${companyId}`);
    }

    try {
      const job = await this.whatsappQueue.add('sendAutoReply', {
        companyId,
        from: externalId, // No processador interpretamos como destino
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

  async sendBulkMessages(data: {
    companyId: string;
    numbers: string[];
    message: string;
    delayRange?: [number, number];
  }) {
    const { companyId, numbers, message, delayRange = [20000, 40000] } = data;
    const client = this.clients.get(companyId);

    if (!client) {
      throw new BadRequestException('WhatsApp não conectado');
    }

    this.logger.log(`[BULK][${companyId}] Iniciando disparo para ${numbers.length} números.`);

    // Executa em background para não travar a requisição HTTP
    (async () => {
      for (const number of numbers) {
        try {
          // Garante formato correto (+55...)
          const formatted = number.includes('@') ? number : `${number.replace(/\D/g, '')}@c.us`;
          await client.sendText(formatted, message);
          
          const delay = Math.floor(Math.random() * (delayRange[1] - delayRange[0] + 1)) + delayRange[0];
          this.logger.log(`[BULK][${companyId}] Enviado para ${number}. Aguardando ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        } catch (err) {
          this.logger.error(`[BULK-ERR][${companyId}] Falha ao enviar para ${number}: ${err.message}`);
        }
      }
      this.logger.log(`[BULK][${companyId}] Disparo finalizado.`);
    })();

    return { success: true, count: numbers.length };
  }

  async getProfile(companyId: string) {
    const client = this.clients.get(companyId);
    if (!client) return null;
    try {
      return await client.getHostDevice();
    } catch {
      return null;
    }
  }

  async checkLiveStatus(companyId: string) {
    const client = this.clients.get(companyId);
    if (!client) return false;
    try {
      return await client.isConnected();
    } catch {
      return false;
    }
  }

  // ─── Lógica de Engine (Privada) ─────────────────────────────────────────────

  private async bootstrapClient(companyId: string): Promise<WhatsappClient> {
    const neonStore = new NeonTokenStore(this.prisma, companyId, this.logger);

    try {
      this.logger.log(`[WA-INIT][${companyId}] Inicializando motor WPPConnect...`);
      
      const client = await (create as any)({
        session: `company-${companyId}`,
        tokenStore: neonStore,
        headless: true, // Obrigatório para Render.com
        logQR: false,
        updatesLog: false,
        autoClose: 60000,
        waitForLogin: true,
        disableWelcome: true,
        folderNameToken: SESSION_BASE_DIR,
        waVersion: '2.2412.54', // Estabiliza WAPI
        catchQR: (base64Qr: string) => {
          const uri = base64Qr.startsWith('data:') ? base64Qr : `data:image/png;base64,${base64Qr}`;
          this.qrCodes.set(companyId, uri);
          this.statuses.set(companyId, 'QR_READY');
          this.logger.log(`[WA-QR][${companyId}] QR Code disponível para scan.`);
        },
        statusFind: (statusSession: string) => {
          this.handleStatusChange(companyId, statusSession);
        },
        puppeteerOptions: {
          // Evita crash se o binário específico não existir. No Render, o Puppeteer 
          // geralmente instala o Chromium na cache local, e remover o path fixo permite 
          // que ele encontre o binário automaticamente.
          executablePath: process.env.CHROME_PATH || undefined, 
          args: [
            `--user-agent=${WHATSAPP_USER_AGENT}`,
            '--no-sandbox',                // Essencial: permite rodar em containers sem privilégios de root
            '--disable-setuid-sandbox',     // Reforça a segurança no isolamento do processo
            '--disable-dev-shm-usage',      // Usa /tmp em vez de /dev/shm para evitar crash por falta de memória compartilhada
            '--disable-gpu',                // Desabilita aceleração de hardware (não disponível em servidores cloud)
            '--no-zygote',                  // Previne problemas de fork em ambientes restritos
            '--single-process',             // Economiza memória, rodando o browser em um único processo
            '--disable-extensions',         // Evita overhead de carregar extensões desnecessárias
          ],
        },
      } as any);

      this.clients.set(companyId, client);
      this.initializations.delete(companyId);
      this.qrCodes.delete(companyId);
      
      this.setupMessageListener(client, companyId);
      
      return client;
    } catch (error) {
      this.logger.error(`[WA-FATAL][${companyId}] Falha na inicialização: ${error.message}`);
      this.statuses.set(companyId, 'DISCONNECTED');
      this.initializations.delete(companyId);
      this.cleanupMemory(companyId);
      throw error;
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
      case 'connecting':
      case 'browserClose':
        this.statuses.set(companyId, 'CONNECTING');
        break;
      case 'authenficated':
        this.statuses.set(companyId, 'AUTHENTICATING');
        break;
      default:
        this.statuses.set(companyId, 'DISCONNECTED');
    }

    // Persiste status no banco
    if (this.statuses.get(companyId) === 'CONNECTED') {
      (this.prisma.company as any).update({
        where: { id: companyId },
        data: { whatsappStatus: 'CONNECTED' },
      }).catch(() => null);
    }
  }

  private setupMessageListener(client: WhatsappClient, companyId: string) {
    client.onMessage(async (message: any) => {
      if (message.isGroupMsg) return;
      
      // Enfileira para processamento inteligente
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

  // ─── Helpers ──────────────────────────────────────────────────────────────

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
    this.logger.log('Limpando instâncias do WhatsApp antes do encerramento...');
    for (const [id, client] of this.clients.entries()) {
      await client.close().catch(() => null);
    }
  }
}
