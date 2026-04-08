import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
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

  async logoutSession(companyId: string) {
    const client = this.getClient(companyId);
    if (!client) {
      // Se não tem cliente na memória, ainda limpamos o banco por segurança
      await this.prisma.company.update({
        where: { id: companyId },
        data: { whatsappSessionName: null, whatsappWid: null }
      });
      return { success: true, message: 'Sessão resetada no banco' };
    }

    try {
      await client.logout();
      await client.close();
      this.getClients().delete(companyId);
      this.statuses.delete(companyId);
      this.qrCodes.delete(companyId);

      await this.prisma.company.update({
        where: { id: companyId },
        data: {
          whatsappSessionName: null,
          whatsappWid: null
        }
      });

      return { success: true, message: 'Desconectado com sucesso' };
    } catch (error) {
      this.logger.error(`Erro ao desconectar [${companyId}]: ${(error as Error).message}`);
      // Em caso de erro no logout (ex: browser já fechado), limpamos a memória
      this.getClients().delete(companyId);
      throw new InternalServerErrorException('Falha ao desconectar sessão');
    }
  }

  async terminateSession(companyId: string) {
    const client = this.getClient(companyId);

    if (client) {
      try {
        await client.close();
      } catch (error) {
        this.logger.error(`[WhatsappService] Erro ao fechar cliente [${companyId}]: ${(error as Error).message}`);
      }
    }

    this.getClients().delete(companyId);
    this.initializations.delete(companyId);
    this.statuses.delete(companyId);
    this.qrCodes.delete(companyId);

    this.logger.log(`[WhatsappService] Sessão [${companyId}] encerrada pelo usuário.`);
    return { success: true };
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

    const client = await create({
      session: companyId,
      useChrome: false, // Força o uso do executablePath abaixo
      headless: 'new' as any,
      logQR: false,
      updatesLog: true,
      autoClose: 120000, // Se ninguém ler em 2 minutos, mata o processo sozinho
      waitForLogin: true, // Espera o login completar antes de retornar
      disableWelcome: true,
      folderNameToken: '.wppconnect',
      catchQR: (base64Qr, asciiQR, attempt) => {
        this.logger.log(`QR Code gerado para [${companyId}]. Tentativa ${attempt}.`);
        // Garante o prefixo data URI correto para o frontend
        const qrCodeData = base64Qr.startsWith('data:') ? base64Qr : `data:image/png;base64,${base64Qr}`;
        this.qrCodes.set(companyId, qrCodeData);
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
        headless: 'new' as any,
        // Prioriza a variável do Render, depois o caminho padrão do Linux
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/google-chrome',
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--single-process',
          '--disable-gpu',
          '--disable-extensions', // Desativa extensões que pesam
          '--disable-default-apps',
          '--no-default-browser-check',
        ],
      },
    });

    // Verificação de race condition: se a sessão foi abortada durante a inicialização
    if (!this.initializations.has(companyId) && !this.getClients().has(companyId)) {
      this.logger.warn(`Sessão [${companyId}] foi abortada durante a inicialização. Matando o processo zumbi...`);
      await client.close();
      return client;
    }

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
