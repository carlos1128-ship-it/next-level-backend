import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Query,
  Res,
  Logger,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { Response } from 'express';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../prisma/prisma.service';
import { IntegrationProvider } from '@prisma/client';
import { ActiveCompanyGuard } from '../../common/guards/active-company.guard';
import { MetaIntegrationService } from './meta.service';
import { SaveMetaConfigDto } from './dto/save-meta-config.dto';

@Controller('whatsapp')
@UseGuards(ActiveCompanyGuard)
export class WhatsappConfigController {
  constructor(private readonly metaIntegrationService: MetaIntegrationService) {}

  @Post('config')
  async saveMetaConfig(
    @Query('companyId') companyId: string,
    @Body() dto: SaveMetaConfigDto,
  ) {
    return this.metaIntegrationService.saveConfig(companyId, dto);
  }

  @Delete('config')
  async deleteMetaConfig(
    @Query('companyId') companyId: string,
  ) {
    return this.metaIntegrationService.deleteConfig(companyId);
  }
}

@Controller('meta')
@UseGuards(ActiveCompanyGuard)
export class MetaStatusController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('status')
  async getConnectionStatus(@Query('companyId') companyId: string) {
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: {
        metaPhoneNumberId: true,
        metaAccessToken: true,
        phoneNumber: true,
      },
    });

    return {
      connected: !!(company?.metaPhoneNumberId && company?.metaAccessToken),
      phoneNumberId: company?.metaPhoneNumberId ?? null,
      phoneNumber: company?.phoneNumber ?? null,
    };
  }
}

@Controller('webhooks/meta')
export class MetaIntegrationController {
  private readonly logger = new Logger(MetaIntegrationController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * GET /webhooks/meta
   * Meta webhook verification challenge.
   * Checks per-company webhookVerifyToken OR global META_VERIFY_TOKEN env var.
   */
  @Get()
  async verifyWebhook(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
    @Res() res: Response,
  ) {
    this.logger.log(`Webhook verification — mode: ${mode}`);

    if (mode !== 'subscribe' || !token) {
      return res.sendStatus(HttpStatus.BAD_REQUEST);
    }

    // 1) Match against global system token
    if (token === process.env.META_VERIFY_TOKEN) {
      this.logger.log('Webhook verified via system token.');
      return res.status(HttpStatus.OK).send(challenge);
    }

    // 2) Match against per-company token (multi-tenant)
    const company = await this.prisma.company.findFirst({
      where: { webhookVerifyToken: token },
      select: { id: true, name: true },
    });

    if (company) {
      this.logger.log(`Webhook verified for company: ${company.name} (${company.id})`);
      return res.status(HttpStatus.OK).send(challenge);
    }

    this.logger.warn(`Webhook verification failed — token mismatch.`);
    return res.sendStatus(HttpStatus.FORBIDDEN);
  }

  /**
   * POST /webhooks/meta
   * Receives WhatsApp Business and Instagram DM messages.
   * Emits 'webhooks.received' event for AttendantService to process.
   */
  @Post()
  async handleIncomingMessage(
    @Body() body: any,
    @Res() res: Response,
  ) {
    // Always respond 200 immediately so Meta doesn't retry
    res.status(HttpStatus.OK).send('EVENT_RECEIVED');

    const object: string = body?.object;
    if (!object) return;

    this.logger.log(`[Webhook] Received event: ${object}`);

    const entries: any[] = body?.entry ?? [];

    for (const entry of entries) {
      // ── WhatsApp Business ──────────────────────────────────────────────
      if (object === 'whatsapp_business_account') {
        const changes: any[] = entry?.changes ?? [];
        for (const change of changes) {
          const value = change?.value;
          const phoneNumberId: string | undefined = value?.metadata?.phone_number_id;
          if (!phoneNumberId) continue;

          const company = await this.prisma.company.findFirst({
            where: { metaPhoneNumberId: phoneNumberId },
            select: { id: true },
          });

          if (!company) {
            this.logger.warn(`No company found for phoneNumberId: ${phoneNumberId}`);
            continue;
          }

          const webhookEvent = await this.prisma.webhookEvent.create({
            data: {
              companyId: company.id,
              provider: IntegrationProvider.WHATSAPP,
              payload: body,
            },
          });

          this.eventEmitter.emit('webhooks.received', {
            eventId: webhookEvent.id,
            provider: IntegrationProvider.WHATSAPP,
            companyId: company.id,
          });

          this.logger.log(`WhatsApp event queued for company ${company.id}`);
        }
      }

      // ── Instagram DMs ─────────────────────────────────────────────────
      if (object === 'instagram' || object === 'page') {
        const messagingEvents: any[] = entry?.messaging ?? [];
        for (const messaging of messagingEvents) {
          const senderId: string | undefined = messaging?.sender?.id;
          const recipientId: string | undefined = messaging?.recipient?.id;
          if (!senderId || !messaging?.message) continue;

          // recipientId is the Instagram page/account receiving the DM
          const company = await this.prisma.company.findFirst({
            where: { instagramAccountId: recipientId },
            select: { id: true },
          });

          if (!company) {
            this.logger.warn(`No company found for instagramAccountId: ${recipientId}`);
            continue;
          }

          const webhookEvent = await this.prisma.webhookEvent.create({
            data: {
              companyId: company.id,
              provider: IntegrationProvider.INSTAGRAM,
              payload: body,
            },
          });

          this.eventEmitter.emit('webhooks.received', {
            eventId: webhookEvent.id,
            provider: IntegrationProvider.INSTAGRAM,
            companyId: company.id,
          });

          this.logger.log(`Instagram DM event queued for company ${company.id}`);
        }
      }
    }
  }
}
