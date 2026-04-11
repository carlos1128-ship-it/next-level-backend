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
import * as fs from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
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
const RENDER_PUPPETEER_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-accelerated-2d-canvas',
  '--no-first-run',
  '--no-zygote',
  '--single-process',
  '--disable-gpu',
  '--disable-extensions',
];
const BROWSER_PATH_CANDIDATES = [
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];
const PUPPETEER_CACHE_ROOTS = [
  path.join(process.cwd(), '.cache', 'puppeteer'),
  '/opt/render/project/src/.cache/puppeteer',
  '/opt/render/.cache/puppeteer',
];

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

  async sendBulkMessages(data: {
    companyId: string;
    numbers: string[];
    message: string;
    delayRange?: [number, number];
  }) {
    const { companyId, numbers, message, delayRange = [20000, 40000] } = data;

    if (!this.clients.has(companyId)) {
      throw new BadRequestException('WhatsApp não conectado');
    }

    this.logger.log(`[BULK][${companyId}] Iniciando disparo para ${numbers.length} números.`);

    let cumulativeDelay = 0;

    for (const number of numbers) {
      const randomDelay =
        Math.floor(Math.random() * (delayRange[1] - delayRange[0] + 1)) + delayRange[0];

      await this.whatsappQueue.add(
        'sendBulkMessage',
        {
          companyId,
          phoneNumber: number,
          message,
        },
        {
          delay: cumulativeDelay,
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
          removeOnComplete: true,
          removeOnFail: false,
        },
      );

      cumulativeDelay += randomDelay;
    }

    return { success: true, count: numbers.length, queued: true };
  }

  async getProfile(companyId: string) {
    const client = this.clients.get(companyId);
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: {
        whatsappStatus: true,
        whatsappWid: true,
        whatsappName: true,
        whatsappAvatar: true,
      } as any,
    });

    let hostDevice: any = null;
    if (client) {
      try {
        hostDevice = await client.getHostDevice();
      } catch {
        hostDevice = null;
      }
    }

    const liveWid =
      hostDevice?.wid?._serialized ||
      (hostDevice?.wid?.user ? `${hostDevice.wid.user}@c.us` : null);

    return {
      status: this.getStatus(companyId) || (company as any)?.whatsappStatus || 'DISCONNECTED',
      wid: liveWid || (company as any)?.whatsappWid || null,
      phoneNumber:
        hostDevice?.wid?.user ||
        ((company as any)?.whatsappWid ? String((company as any).whatsappWid).replace('@c.us', '') : null),
      name:
        hostDevice?.pushname ||
        hostDevice?.formattedName ||
        hostDevice?.name ||
        (company as any)?.whatsappName ||
        null,
      profilePicUrl: (company as any)?.whatsappAvatar || null,
      raw: hostDevice,
    };
  }

  async checkLiveStatus(companyId: string) {
    const client = this.clients.get(companyId);
    if (!client) return false;
    try {
      const connected = await client.isConnected();
      if (connected) {
        this.statuses.set(companyId, 'CONNECTED');
        await this.syncConnectedProfile(companyId, client);
      } else {
        this.statuses.set(companyId, 'DISCONNECTED');
        await (this.prisma.company as any).update({
          where: { id: companyId },
          data: { whatsappStatus: 'DISCONNECTED' },
        }).catch(() => null);
      }
      return connected;
    } catch {
      return false;
    }
  }

  // ─── Lógica de Engine (Privada) ─────────────────────────────────────────────

  private async bootstrapClient(companyId: string, recovered = false): Promise<WhatsappClient | null> {
    const neonStore = new NeonTokenStore(this.prisma, companyId, this.logger);
    const sessionName = `company-${companyId}`;

    try {
      this.logger.log(`[WA-INIT][${companyId}] Inicializando motor WPPConnect...`);
      await this.ensureSessionBaseDir();
      
      const client = await (create as any)({
        session: sessionName,
        tokenStore: neonStore,
        headless: 'new', // Recomendado para versões recentes do Puppeteer
        logQR: false,
        updatesLog: false,
        autoClose: 0,    // PATCH: Desabilitado para evitar "Auto Close Called" fatal
        waitForLogin: true,
        disableWelcome: true,
        folderNameToken: SESSION_BASE_DIR,
        waVersion: '2.2412.54',
        catchQR: (base64Qr: string, _asciiQr: string, attempts?: number) => {
          this.logger.log(`[QR-CODE][${companyId}] Gerado. Tentativa: ${attempts ?? 1}`);
          const uri = base64Qr.startsWith('data:') ? base64Qr : `data:image/png;base64,${base64Qr}`;
          this.qrCodes.set(companyId, uri);
          this.statuses.set(companyId, 'QR_READY');
        },
        statusFind: (statusSession: string) => {
          this.handleStatusChange(companyId, statusSession);
        },
        puppeteerOptions: {
          executablePath: this.resolveBrowserExecutablePath(),
          userDataDir: this.getSessionDir(companyId),
          args: [
            `--user-agent=${WHATSAPP_USER_AGENT}`,
            ...RENDER_PUPPETEER_ARGS,
          ],
        },
      } as any);

      this.clients.set(companyId, client);
      this.initializations.delete(companyId);
      this.qrCodes.delete(companyId);
      
      this.setupMessageListener(client, companyId);
      await this.syncConnectedProfile(companyId, client);
      
      return client;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);

      if (!recovered && this.shouldResetSessionArtifacts(msg)) {
        this.logger.warn(`[WA-LOCK][${companyId}] Sessão travada detectada (${msg}). Limpando artefatos e tentando novamente...`);
        await this.cleanupStaleSessionFiles(companyId);
        return this.bootstrapClient(companyId, true);
      }
      
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
        this.logger.warn(`[WA-RETRY][${companyId}] Estado crítico detectado: ${status}. Reiniciando em 20s...`);
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

      const client = this.clients.get(companyId);
      if (client) {
        void this.syncConnectedProfile(companyId, client);
      }
    }
  }

  /**
   * PATCH: Lógica de retry resiliente para evitar Unhandled Rejections
   */
  private handleRetry(companyId: string) {
    this.cleanupMemory(companyId);
    void this.forceCleanup(companyId);
    setTimeout(() => {
      void this.forceCleanup(companyId);
      this.createSession(companyId).catch(err => 
        this.logger.error(`[WA-RETRY-FAILED][${companyId}] Erro ao reiniciar: ${err.message}`)
      );
    }, 20000); // 20s para o Chromium liberar sockets e arquivos
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
      if ((state as any) === 'CONNECTED') {
        this.statuses.set(companyId, 'CONNECTED');
        await this.syncConnectedProfile(companyId, client);
      }
      if ((state as any) === 'DISCONNECTED') await this.terminateSession(companyId);
    });
  }

  getQrCode(companyId: string) {
    return this.qrCodes.get(companyId);
  }

  getClient(companyId: string) {
    return this.clients.get(companyId) || null;
  }

  private cleanupMemory(companyId: string) {
    this.clients.delete(companyId);
    this.initializations.delete(companyId);
    this.qrCodes.delete(companyId);
    this.statuses.delete(companyId);
  }

  private async ensureSessionBaseDir() {
    await mkdir(SESSION_BASE_DIR, { recursive: true }).catch(() => null);
  }

  private resolveBrowserExecutablePath() {
    const configuredPaths = [
      process.env.PUPPETEER_EXECUTABLE_PATH,
      process.env.CHROME_PATH,
    ].filter((value): value is string => Boolean(value?.trim()));

    for (const candidate of [...configuredPaths, ...BROWSER_PATH_CANDIDATES]) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }

    if (configuredPaths.length > 0) {
      this.logger.warn(
        `[WA-BROWSER] Nenhum executavel encontrado nos caminhos configurados: ${configuredPaths.join(', ')}. Usando autodeteccao do Puppeteer/WPPConnect.`,
      );
    }

    for (const cacheRoot of PUPPETEER_CACHE_ROOTS) {
      const discoveredPath = this.findBrowserInDirectory(cacheRoot, 4);
      if (discoveredPath) {
        this.logger.log(`[WA-BROWSER] Executavel encontrado na cache do Puppeteer: ${discoveredPath}`);
        return discoveredPath;
      }
    }

    return undefined;
  }

  private findBrowserInDirectory(baseDir: string, depth: number): string | null {
    if (depth < 0 || !fs.existsSync(baseDir)) {
      return null;
    }

    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(baseDir, { withFileTypes: true });
    } catch {
      return null;
    }

    for (const entry of entries) {
      const fullPath = path.join(baseDir, entry.name);

      if (entry.isFile() && ['chrome', 'google-chrome', 'google-chrome-stable', 'chromium'].includes(entry.name)) {
        return fullPath;
      }

      if (entry.isDirectory()) {
        const nested = this.findBrowserInDirectory(fullPath, depth - 1);
        if (nested) {
          return nested;
        }
      }
    }

    return null;
  }

  private getSessionDir(companyId: string) {
    return path.posix.join(SESSION_BASE_DIR, `company-${companyId}`);
  }

  private async cleanupStaleSessionFiles(companyId: string) {
    await this.forceCleanup(companyId);
  }

  private async forceCleanup(companyId: string) {
    const sessionPath = this.getSessionDir(companyId);
    this.logger.log(`[WA-CLEANUP][${companyId}] Iniciando limpeza pesada em ${sessionPath}`);

    try {
      if (fs.existsSync(sessionPath)) {
        fs.rmSync(sessionPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 1000 });
        this.logger.log(`[WA-CLEANUP][${companyId}] Pasta da sessão removida.`);
      }
      return;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.warn(`[WA-CLEANUP][${companyId}] Falha inicial ao apagar sessão: ${msg}`);
    }

    try {
      if (!fs.existsSync(sessionPath)) {
        return;
      }

      const tempPath = `${sessionPath}-old-${Date.now()}`;
      fs.renameSync(sessionPath, tempPath);
      fs.rmSync(tempPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 1000 });
      this.logger.log(`[WA-CLEANUP][${companyId}] Sessão renomeada e removida com sucesso.`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`[WA-FATAL][${companyId}] Não foi possível limpar a pasta da sessão: ${msg}`);
    }
  }

  private shouldResetSessionArtifacts(message: string) {
    const normalized = message.toLowerCase();
    return (
      normalized.includes('browser is already running') ||
      normalized.includes('singletonlock') ||
      normalized.includes('singletonsocket') ||
      normalized.includes('singletoncookie') ||
      normalized.includes('lock file') ||
      normalized.includes('target closed') ||
      normalized.includes('failed to launch the browser process')
    );
  }

  private async syncConnectedProfile(companyId: string, client: WhatsappClient) {
    try {
      const hostDevice = await client.getHostDevice() as any;
      const wid =
        hostDevice?.wid?._serialized ||
        (hostDevice?.wid?.user ? `${hostDevice.wid.user}@c.us` : null);
      const phoneNumber = hostDevice?.wid?.user || null;
      const displayName =
        hostDevice?.pushname || hostDevice?.formattedName || hostDevice?.name || phoneNumber;

      let avatarUrl: string | null = null;
      if (wid) {
        try {
          const profilePic = await client.getProfilePicFromServer(wid);
          avatarUrl =
            (profilePic as any)?.eurl ||
            (profilePic as any)?.imgFull ||
            (profilePic as any)?.img ||
            null;
        } catch {
          avatarUrl = null;
        }
      }

      await (this.prisma.company as any).update({
        where: { id: companyId },
        data: {
          whatsappStatus: 'CONNECTED',
          whatsappSessionName: `company-${companyId}`,
          whatsappWid: wid,
          whatsappName: displayName,
          whatsappAvatar: avatarUrl,
        },
      }).catch(() => null);

      this.logger.log(
        `[WA-PROFILE][${companyId}] Perfil sincronizado (${displayName || 'sem nome'} / ${phoneNumber || 'sem numero'})`,
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.warn(`[WA-PROFILE][${companyId}] Falha ao sincronizar perfil: ${msg}`);
    }
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
