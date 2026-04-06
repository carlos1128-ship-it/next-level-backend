import {
  Body,
  Controller,
  Headers,
  Logger,
  Post,
  Query,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IntegrationProvider } from '@prisma/client';
import { Public } from '../../common/decorators/public.decorator';
import { AttendantService } from '../attendant/attendant.service';
import { WebhookIngestService } from './webhook-ingest.service';

@Controller('webhook')
export class EvolutionWebhookController {
  private readonly logger = new Logger(EvolutionWebhookController.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly attendantService: AttendantService,
    private readonly webhookIngestService: WebhookIngestService,
  ) {}

  @Public()
  @Post('whatsapp')
  async handleWhatsappWebhook(
    @Query('companyId') companyIdQuery: string | undefined,
    @Query('token') tokenQuery: string | undefined,
    @Headers('apikey') apiKey: string | undefined,
    @Headers('x-webhook-secret') webhookSecret: string | undefined,
    @Body() body: Record<string, unknown>,
  ) {
    const expectedSecret =
      this.configService.get<string>('EVOLUTION_WEBHOOK_SECRET')?.trim() || '';

    if (expectedSecret) {
      const receivedSecret = webhookSecret || apiKey || tokenQuery || '';
      if (receivedSecret !== expectedSecret) {
        return { ok: false };
      }
    }

    const event = body?.['event'] as string | undefined;
    if (event !== 'messages.upsert') {
      return { ok: true, ignored: true };
    }

    const data = body?.['data'] as Record<string, unknown> | undefined;
    const key = data?.['key'] as Record<string, unknown> | undefined;
    if (key?.['fromMe'] === true) {
      return { ok: true, ignored: true };
    }

    const instanceName = typeof body?.['instance'] === 'string' ? body.instance : '';
    const companyId =
      companyIdQuery?.trim() ||
      (instanceName
        ? await this.attendantService.findCompanyIdByInstanceName(instanceName)
        : null);

    try {
      const { event: storedEvent } = await this.webhookIngestService.registerEvent(
        IntegrationProvider.WHATSAPP,
        body,
        instanceName || null,
        companyId,
      );

      return {
        ok: true,
        eventId: storedEvent.id,
        companyId,
      };
    } catch (error) {
      this.logger.error('Falha ao salvar webhook Evolution', error as Error);
      return { ok: true, stored: false };
    }
  }
}
