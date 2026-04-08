import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleDestroy,
} from '@nestjs/common';
import {
  create,
  Whatsapp as WppWhatsapp,
} from '@wppconnect-team/wppconnect';
import puppeteer from 'puppeteer';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../prisma/prisma.service';

interface SendTemplateInput {
  to: string;
  template: string;
  language?: string;
  components?: Array<Record<string, unknown>>;
}

type GlobalWithWpp = typeof globalThis & {
  __NEXT_LEVEL_WPP_CLIENTS__?: Map<string, WppWhatsapp>;
};

@Injectable()
export class WhatsappService implements OnModuleDestroy {
  private readonly logger = new Logger(WhatsappService.name);
  private initializations = new Map<string, Promise<WppWhatsapp>>();
  private qrCodes = new Map<string, string>();
  private statuses = new Map<string, string>();

  constructor(
    private readonly eventEmitter: EventEmitter2,
    private readonly prisma: PrismaService,
  ) {
    if (!(globalThis as GlobalWithWpp).__NEXT_LEVEL_WPP_CLIENTS__) {
      (globalThis as GlobalWithWpp).__NEXT_LEVEL_WPP_CLIENTS__ = new Map();
    }
  }

  getStatus(companyId: string): string {
    return this.statuses.get(companyId) || 'Disconnected';
  }

  async onModuleDestroy() {
    const clients = this.getClients();
    for (const [session, client] of clients.entries()) {
      try {
        await client.close();
      } catch (error) {
        this.logger.warn(`Falha ao encerrar cliente WPPConnect [${session}]: ${(error as Error).message}`);
      }
    }
  }

  private getClients() {
    return (globalThis as GlobalWithWpp).__NEXT_LEVEL_WPP_CLIENTS__!;
  }

  getClient(companyId: string): WppWhatsapp | undefined {
    return this.getClients().get(companyId);
  }

  getQrCode(companyId: string): string | null {
    return this.qrCodes.get(companyId) || null;
  }

  async createSession(companyId: string): Promise<{ success: boolean; message: string }> {
    const existing = this.getClient(companyId);
    if (existing) {
      return { success: true, message: 'Session já conectada' };
    }

    if (!this.initializations.has(companyId)) {
      this.initializations.set(companyId, this.bootstrapClient(companyId));
    }

    return { success: true, message: 'Sessão iniciada' };
  }

  async sendTextMessage(companyId: string, to: string, message: string) {
    const client = this.getClient(companyId);
    if (!client) throw new BadRequestException('WhatsApp não conectado');
    const recipient = this.normalizeRecipient(to);
    await client.sendText(recipient, message);
    return { sent: true };
  }

  async sendTemplateMessage(companyId: string, payload: SendTemplateInput) {
    if (!payload.template) {
      throw new BadRequestException('template obrigatorio');
    }

    const client = this.getClient(companyId);
    if (!client) throw new BadRequestException('WhatsApp não conectado');

    const recipient = this.normalizeRecipient(payload.to);
    const body = [
      `Template: ${payload.template}`,
      payload.language ? `Idioma: ${payload.language}` : '',
      payload.components?.length
        ? `Componentes: ${JSON.stringify(payload.components)}`
        : '',
    ]
      .filter(Boolean)
      .join('\n');

    await client.sendText(recipient, body);
    return { sent: true };
  }

  async discoverBusinessProfile() {
    throw new BadRequestException(
      'Discover Business Profile foi desativado no modo local com WPPConnect.',
    );
  }

  private async bootstrapClient(companyId: string): Promise<WppWhatsapp> {
    this.logger.log(`Inicializando sessao do WhatsApp [${companyId}] via WPPConnect...`);

    this.logger.log(`Detectando executavel do Chrome/Chromium...`);
    const possiblePaths = [
      process.env.PUPPETEER_EXECUTABLE_PATH,
      puppeteer.executablePath(),
      '/usr/bin/google-chrome',
      '/usr/bin/chromium-browser',
      '/usr/bin/chromium',
    ].filter(Boolean) as string[];

    let resolvedPath: string | undefined;
    for (const p of possiblePaths) {
      if (require('fs').existsSync(p)) {
        resolvedPath = p;
        this.logger.log(`Navegador encontrado em: ${p}`);
        break;
      }
    }

    if (!resolvedPath) {
      this.logger.warn(`Nenhum binario encontrado nos caminhos conhecidos. Tentando padrao do puppeteer.`);
      resolvedPath = puppeteer.executablePath();
    }

    const client = await create({
      session: companyId,
      useChrome: true,
      headless: this.resolveHeadless(),
      logQR: false,
      updatesLog: true,
      autoClose: 0,
      waitForLogin: false,
      disableWelcome: true,
      folderNameToken: '.wppconnect',
      catchQR: (base64Qr, asciiQR, attempt) => {
        this.logger.log(`QR Code gerado para [${companyId}]. Tentativa ${attempt}.`);
        this.qrCodes.set(companyId, base64Qr);
      },
      statusFind: async (status, session) => {
        this.logger.log(`WPPConnect [${session}] status=${String(status)}`);
        
        if (status === 'isLogged' || status === 'inChat') {
          this.statuses.set(companyId, 'Connected');
          this.qrCodes.delete(companyId);
          try {
            const hostDevice = await client.getHostDevice();
            const widStr = typeof hostDevice.wid === 'string' ? hostDevice.wid : (hostDevice.wid as any)?._serialized || (hostDevice.id as any)?._serialized;
            if (widStr) {
               await this.prisma.company.update({
                where: { id: companyId },
                data: { 
                  whatsappSessionName: session,
                  whatsappWid: String(widStr),
                },
              });
            }
          } catch (e) {
            this.logger.warn(`Erro ao salvar WID [${session}]: ${(e as Error).message}`);
          }
        }
      },
      onLoadingScreen: (percent, message) => {
        this.logger.log(`WPPConnect [${companyId}] carregando ${percent}% - ${message}`);
      },
      puppeteerOptions: {
        userDataDir: `.wppconnect/${companyId}`,
        executablePath: resolvedPath,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--no-first-run',
          '--no-zygote',
          '--single-process',
        ],
      },
    });

    this.getClients().set(companyId, client);
    this.initializations.delete(companyId);
    this.logger.log(`Cliente WPPConnect [${companyId}] pronto para envio.`);

    client.onMessage(async (message) => {
      if (message.isGroupMsg) return;

      const content = message.body || '';
      const from = message.from;
      const name = message.sender?.pushname || message.sender?.name;
      
      this.eventEmitter.emit('whatsapp.message.received', {
        companyId,
        from,
        text: content,
        name,
      });
    });

    return client;
  }

  private normalizeRecipient(value: string) {
    const trimmed = value.trim();
    if (!trimmed) {
      throw new BadRequestException('numero de destino obrigatorio');
    }
    if (trimmed.includes('@')) {
      return trimmed;
    }
    const digits = trimmed.replace(/\D/g, '');
    if (!digits) {
      throw new BadRequestException('numero de destino invalido');
    }
    return `${digits}@c.us`;
  }

  private resolveHeadless(): boolean | 'shell' {
    const raw = (process.env.WPPCONNECT_HEADLESS || 'true').trim().toLowerCase();
    if (raw === 'shell') return 'shell';
    return raw !== 'false';
  }
}
