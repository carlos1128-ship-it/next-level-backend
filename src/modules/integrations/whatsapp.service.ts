import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import {
  create,
  Whatsapp as WppWhatsapp,
} from '@wppconnect-team/wppconnect';

interface SendTemplateInput {
  to: string;
  template: string;
  language?: string;
  components?: Array<Record<string, unknown>>;
}

type GlobalWithWpp = typeof globalThis & {
  __NEXT_LEVEL_WPP_CLIENT__?: WppWhatsapp;
};

@Injectable()
export class WhatsappService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WhatsappService.name);
  private initializingClient?: Promise<WppWhatsapp>;

  async onModuleInit() {
    await this.ensureClient();
  }

  async onModuleDestroy() {
    const client = this.getClient();
    if (!client) return;

    try {
      await client.close();
    } catch (error) {
      this.logger.warn(
        `Falha ao encerrar cliente WPPConnect: ${(error as Error).message}`,
      );
    }
  }

  getClient() {
    return (globalThis as GlobalWithWpp).__NEXT_LEVEL_WPP_CLIENT__;
  }

  async sendTextMessage(_companyId: string, to: string, message: string) {
    const client = await this.ensureClient();
    const recipient = this.normalizeRecipient(to);
    await client.sendText(recipient, message);
    return { sent: true };
  }

  async sendTemplateMessage(_companyId: string, payload: SendTemplateInput) {
    if (!payload.template) {
      throw new BadRequestException('template obrigatorio');
    }

    const client = await this.ensureClient();
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

  private async ensureClient(): Promise<WppWhatsapp> {
    const existing = this.getClient();
    if (existing) return existing;

    if (!this.initializingClient) {
      this.initializingClient = this.bootstrapClient();
    }

    return this.initializingClient;
  }

  private async bootstrapClient(): Promise<WppWhatsapp> {
    this.logger.log('Inicializando sessao local do WhatsApp via WPPConnect...');

    const client = await create({
      session: process.env.WPPCONNECT_SESSION || 'next-level-local',
      headless: this.resolveHeadless(),
      logQR: true,
      updatesLog: true,
      autoClose: 0,
      waitForLogin: false,
      disableWelcome: true,
      folderNameToken: '.wppconnect',
      catchQR: (_base64Qr, asciiQR, attempt) => {
        this.logger.log(`QR Code do WhatsApp gerado. Tentativa ${attempt}.`);
        console.log('\n=== QR CODE WPPCONNECT ===\n');
        console.log(asciiQR);
        console.log('\n=========================\n');
      },
      statusFind: (status, session) => {
        this.logger.log(`WPPConnect status=${String(status)} session=${session}`);
      },
      onLoadingScreen: (percent, message) => {
        this.logger.log(`WPPConnect carregando ${percent}% - ${message}`);
      },
      browserArgs: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    (globalThis as GlobalWithWpp).__NEXT_LEVEL_WPP_CLIENT__ = client;
    this.initializingClient = undefined;
    this.logger.log('Cliente WPPConnect pronto para envio com client.sendText().');

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
