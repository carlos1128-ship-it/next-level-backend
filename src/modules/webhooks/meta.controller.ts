import { Controller, Post, Headers, Body, Get, Query, BadRequestException } from '@nestjs/common';
import { Public } from '../../common/decorators/public.decorator';
import { WebhooksMetaService } from './webhooks-meta.service';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

/**
 * Webhook Meta Ads: recebe eventos de custos de anúncios e sincroniza.
 * POST /webhooks/meta
 * GET /webhooks/meta?hub.mode=subscribe&hub.verify_token=... (verificação do Meta)
 * Validação de origem via verify_token e assinatura quando aplicável.
 */
@Controller('webhooks/meta')
export class MetaController {
  constructor(
    private readonly webhooksMetaService: WebhooksMetaService,
    private readonly configService: ConfigService,
  ) {}

  @Public()
  @Get()
  verify(@Query('hub.mode') mode: string, @Query('hub.verify_token') token: string, @Query('hub.challenge') challenge: string) {
    const verifyToken = this.configService.get<string>('META_WEBHOOK_VERIFY_TOKEN');
    if (mode === 'subscribe' && verifyToken && token === verifyToken) {
      return challenge;
    }
    throw new BadRequestException('Verificação do webhook Meta falhou');
  }

  @Public()
  @Post()
  async handle(
    @Headers('x-hub-signature-256') signature: string,
    @Body() body: Record<string, unknown>,
  ) {
    const appSecret = this.configService.get<string>('META_APP_SECRET');
    if (appSecret && signature) {
      const expected = 'sha256=' + crypto
        .createHmac('sha256', appSecret)
        .update(JSON.stringify(body))
        .digest('hex');
      if (signature !== expected) {
        throw new BadRequestException('Assinatura Meta inválida');
      }
    }

    return this.webhooksMetaService.processWebhook(body);
  }
}
