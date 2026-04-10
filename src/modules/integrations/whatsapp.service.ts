/**
 * =============================================================================
 * WHATSAPP SERVICE — Multi-tenant + BullMQ + Neon Persistence
 * =============================================================================
 */

import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  OnModuleDestroy,
  OnApplicationShutdown,
} from '@nestjs/common';
import {
  create,
  Whatsapp as WppWhatsapp,
} from '@wppconnect-team/wppconnect';
import type {
  SessionToken,
  TokenStore,
} from '@wppconnect-team/wppconnect/dist/token-store/types';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../../prisma/prisma.service';
import * as fs from 'fs';
import * as path from 'path';

// ─── Constants ────────────────────────────────────────────────────────────────

const DEADLOCK_TIMEOUT_MS = 20_000;
const SESSION_BASE_DIR = '/tmp/.wppconnect';

// Optimized for Render.com
const CHROMIUM_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-accelerated-2d-canvas',
  '--no-first-run',
  '--no-zygote',
  '--single-process',
  '--disable-gpu',
  '--disable-extensions',
  '--disable-default-apps',
  '--no-default-browser-check',
];

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

      const comp = company as any;
      if (!comp?.whatsappSessionToken) return undefined;

      return JSON.parse(comp.whatsappSessionToken) as SessionToken;
    } catch (err: unknown) {
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
export class WhatsappService implements OnModuleDestroy, OnApplicationShutdown {
  private readonly logger = new Logger(WhatsappService.name);
  private readonly clients = new Map<string, WppWhatsapp>();
  private readonly initializations = new Map<string, Promise<WppWhatsapp>>();
  private readonly qrCodes = new Map<string, string>();
  private readonly statuses = new Map<string, 'GENERATING' | 'WAITING_SCAN' | 'CONNECTED' | 'ERROR' | 'DISCONNECTED'>();

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue('whatsapp-queue') private readonly messageQueue: Queue,
  ) {
    // Restaurar sessões ativas globalmente se necessário
  }

  // ─── Controladores da Sessão ────────────────────────────────────────────────

  async startSession(companyId: string) {
    if (this.clients.has(companyId)) return { status: 'CONNECTED' };
    
    if (this.initializations.has(companyId)) {
      return { status: this.statuses.get(companyId) || 'GENERATING' };
    }

    this.statuses.set(companyId, 'GENERATING');
    this.initializations.set(companyId, this.bootstrapClient(companyId));
    
    return { status: 'GENERATING' };
  }

  private async bootstrapClient(companyId: string): Promise<WppWhatsapp> {
    const neonStore = new NeonTokenStore(this.prisma, companyId, this.logger);

    try {
      this.logger.log(`[WA-INIT][${companyId}] Iniciando Puppeteer...`);
      
      const client = await create({
        session: `company-${companyId}`,
        tokenStore: neonStore,
        headless: true, // Use headless true for Render compatibility
        logQR: false,
        updatesLog: false,
        autoClose: 60000,
        waitForLogin: true,
        disableWelcome: true,
        folderNameToken: SESSION_BASE_DIR,
        // @ts-ignore
        waVersion: '2.2412.54', // Fix for WAPI is not defined
        catchQR: (base64Qr: string) => {
          const uri = base64Qr.startsWith('data:') ? base64Qr : `data:image/png;base64,${base64Qr}`;
          this.qrCodes.set(companyId, uri);
          this.statuses.set(companyId, 'WAITING_SCAN');
          this.logger.log(`[WA-QR][${companyId}] QR Code gerado.`);
        },
        statusFind: (statusSession: string) => {
          this.logger.log(`[WA-STATUS][${companyId}] ${statusSession}`);
          if (statusSession === 'isLogged' || statusSession === 'qrReadSuccess') {
            this.statuses.set(companyId, 'CONNECTED');
          }
        },
        puppeteerOptions: {
          headless: true,
          executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
          args: [`--user-agent=${WHATSAPP_USER_AGENT}`, ...CHROMIUM_ARGS],
        },
      } as any);

      this.clients.set(companyId, client);
      this.initializations.delete(companyId);
      this.qrCodes.delete(companyId);
      this.statuses.set(companyId, 'CONNECTED');

      this.setupListeners(client, companyId);
      
      return client;
    } catch (error) {
      this.logger.error(`[WA-ERROR][${companyId}] Falha fatal: ${error.message}`);
      this.statuses.set(companyId, 'ERROR');
      this.initializations.delete(companyId);
      this.cleanupMemory(companyId);
      throw error;
    }
  }

  private setupListeners(client: WppWhatsapp, companyId: string) {
    client.onStateChange(async (state) => {
      this.logger.log(`[WA-STATE][${companyId}] ${state}`);
      if ((state as any) === 'CONNECTED') {
        this.statuses.set(companyId, 'CONNECTED');
      } else if ((state as any) === 'CONFLICT' || (state as any) === 'UNLAUNCHED') {
        await client.useHere();
      } else if ((state as any) === 'DISCONNECTED' || (state as any) === 'UNPAIRED') {
        this.statuses.set(companyId, 'DISCONNECTED');
        await this.disconnect(companyId);
      }
    });

    client.onMessage(async (message: any) => {
      if (message.isGroupMsg) return;
      if (!message.body) return;

      // Enfileirar no BullMQ
      await this.messageQueue.add('processIncomingMessage', {
        companyId,
        from: message.from,
        message: message.body,
        name: message.sender?.pushname || message.sender?.name,
      }, {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 }
      });

      // Também agendar resposta automática
      await this.messageQueue.add('sendAutoReply', {
        companyId,
        from: message.from,
        message: message.body,
      }, {
        attempts: 1,
        priority: 1
      });
    });
  }

  // ─── Controller Support Methods ──────────────────────────────────────────────

  async checkLiveStatus(companyId: string) {
    const client = this.clients.get(companyId);
    if (!client) return;

    try {
      const isConnected = await client.isConnected();
      if (isConnected) {
        this.statuses.set(companyId, 'CONNECTED');
      } else {
        this.statuses.set(companyId, 'DISCONNECTED');
      }
    } catch {
      this.statuses.set(companyId, 'DISCONNECTED');
    }
  }

  async getProfile(companyId: string) {
    const client = this.clients.get(companyId);
    if (!client) return { status: 'DISCONNECTED' };

    try {
      const device = await client.getHostDevice();
      return {
        name: (device as any).notifyName || 'Unknown',
        number: device.wid.user,
        connected: true,
      };
    } catch {
      return { status: 'RECONNECTING' };
    }
  }

  async sendBulkMessages(companyId: string, numbers: string[], message: string) {
    const client = this.clients.get(companyId);
    if (!client) throw new BadRequestException('Sessão não conectada');

    this.logger.log(`[BULK][${companyId}] Iniciando disparo para ${numbers.length} números`);

    // Processamento assíncrono para não travar o worker
    const processBulk = async () => {
      for (const num of numbers) {
        try {
          await this.sendText(companyId, num, message);
          // Anti-ban delay: 20-40 seconds
          const delay = Math.floor(Math.random() * (40000 - 20000 + 1) + 20000);
          await new Promise(resolve => setTimeout(resolve, delay));
        } catch (err) {
          this.logger.error(`[BULK-ERROR][${companyId}] Falha ao enviar para ${num}: ${err.message}`);
        }
      }
    };

    processBulk(); // Executa em background

    return { success: true, message: 'Disparo iniciado com sucesso' };
  }

  async sendText(companyId: string, to: string, text: string) {
    const client = this.clients.get(companyId);
    if (!client) throw new BadRequestException('Sessão não conectada');
    return client.sendText(this.normalizeNumber(to), text);
  }

  async disconnect(companyId: string) {
    const client = this.clients.get(companyId);
    if (client) {
      await client.logout().catch(() => null);
      await client.close().catch(() => null);
    }
    this.cleanupMemory(companyId);
    await this.prisma.company.update({
      where: { id: companyId },
      data: { whatsappStatus: 'DISCONNECTED' } as any,
    }).catch(() => null);
    return { success: true };
  }

  // ─── Getters ────────────────────────────────────────────────────────────────

  getQrCode(companyId: string) {
    return this.qrCodes.get(companyId);
  }

  getSessionStatus(companyId: string) {
    return this.statuses.get(companyId) || 'DISCONNECTED';
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────────

  async onModuleDestroy() {
    await this.shutdownAll();
  }

  async onApplicationShutdown() {
    await this.shutdownAll();
  }

  private async shutdownAll() {
    for (const [companyId, client] of this.clients.entries()) {
      await client.close().catch(() => null);
    }
  }

  private cleanupMemory(companyId: string) {
    this.clients.delete(companyId);
    this.initializations.delete(companyId);
    this.qrCodes.delete(companyId);
    this.statuses.delete(companyId);
  }

  private normalizeNumber(num: string) {
    const digits = num.replace(/\D/g, '');
    return digits.endsWith('@c.us') ? digits : `${digits}@c.us`;
  }
}
