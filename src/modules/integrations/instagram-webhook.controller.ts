import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request, Response } from 'express';
import { Public } from '../../common/decorators/public.decorator';
import { InstagramIntegrationService } from './instagram-integration.service';
import { InstagramMessageProcessorService } from './instagram-message-processor.service';
import { InstagramSendService } from './instagram-send.service';
import { InstagramWebhookService } from './instagram-webhook.service';

type InstagramWebhookRequest = Request & { rawBody?: Buffer };

@Controller('instagram')
export class InstagramWebhookController {
  constructor(
    private readonly configService: ConfigService,
    private readonly instagramWebhookService: InstagramWebhookService,
    private readonly instagramMessageProcessorService: InstagramMessageProcessorService,
    private readonly instagramIntegrationService: InstagramIntegrationService,
    private readonly instagramSendService: InstagramSendService,
  ) {}

  @Public()
  @Get('webhook')
  verifyWebhook(@Req() req: Request, @Res() res: Response) {
    const challengeText = this.instagramWebhookService.verifyWebhookChallenge({
      mode: this.readQueryValue(req.query['hub.mode']),
      verifyToken: this.readQueryValue(req.query['hub.verify_token']),
      challenge: this.readQueryValue(req.query['hub.challenge']),
    });

    return res.status(200).type('text/plain').send(challengeText);
  }

  @Public()
  @Post('webhook')
  webhook(@Req() req: InstagramWebhookRequest) {
    return this.instagramWebhookService.processWebhook(
      req.body as Record<string, unknown>,
      req,
    );
  }

  @Public()
  @Get('internal/resolve-account')
  async resolveAccount(
    @Headers('authorization') authorization: string | undefined,
    @Query('recipientId') recipientId?: string,
    @Query('entryId') entryId?: string,
  ) {
    this.assertInternalToken(authorization);
    const cleanRecipientId = recipientId?.trim();
    if (!cleanRecipientId) {
      throw new BadRequestException('recipientId e obrigatorio');
    }

    const resolution =
      await this.instagramIntegrationService.resolveAccountForWebhookDetailed({
        recipientId: cleanRecipientId,
        instagramAccountId: cleanRecipientId,
        pageId: cleanRecipientId,
        entryId: entryId?.trim() || undefined,
      });

    return {
      recipientId: cleanRecipientId,
      matched: resolution.matched,
      companyId: resolution.account?.companyId || null,
      integrationAccountId: resolution.account?.id || null,
      matchedBy: resolution.matchedBy,
      provider: 'instagram',
      status: resolution.account?.status || null,
      unresolvedReason: resolution.unresolvedReason || null,
    };
  }

  @Public()
  @Post('internal/reprocess-event')
  reprocessEvent(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: { integrationEventId?: string },
  ) {
    this.assertInternalToken(authorization);
    const integrationEventId = body.integrationEventId?.trim();
    if (!integrationEventId) {
      throw new BadRequestException('integrationEventId e obrigatorio');
    }

    return this.instagramMessageProcessorService.reprocessIntegrationEvent(
      integrationEventId,
    );
  }

  @Public()
  @Get('internal/token-status')
  tokenStatus(
    @Headers('authorization') authorization: string | undefined,
    @Query('companyId') companyId?: string,
  ) {
    this.assertInternalToken(authorization);
    const cleanCompanyId = companyId?.trim();
    if (!cleanCompanyId) {
      throw new BadRequestException('companyId e obrigatorio');
    }

    return this.instagramSendService.getTokenStatus(cleanCompanyId);
  }

  @Public()
  @Post('internal/test-send')
  testSend(
    @Headers('authorization') authorization: string | undefined,
    @Body()
    body: {
      companyId?: string;
      recipientId?: string;
      text?: string;
    },
  ) {
    this.assertInternalToken(authorization);
    const companyId = body.companyId?.trim();
    const recipientId = body.recipientId?.trim();
    const text = body.text?.trim();

    if (!companyId || !recipientId || !text) {
      throw new BadRequestException('companyId, recipientId e text sao obrigatorios');
    }

    return this.instagramSendService.testSend(companyId, recipientId, text);
  }

  @Public()
  @Post('internal/import-token')
  importToken(
    @Headers('authorization') authorization: string | undefined,
    @Body()
    body: {
      companyId?: string;
      instagramAccountId?: string;
      username?: string;
      accessToken?: string;
      tokenExpiresAt?: string;
      scopes?: string[];
    },
  ) {
    this.assertInternalToken(authorization);

    return this.instagramSendService.importToken({
      companyId: body.companyId || '',
      instagramAccountId: body.instagramAccountId || '',
      username: body.username || null,
      accessToken: body.accessToken || '',
      tokenExpiresAt: body.tokenExpiresAt || null,
      scopes: Array.isArray(body.scopes) ? body.scopes : undefined,
    });
  }

  @Public()
  @Post('internal/test-ai-reply')
  testAiReply(
    @Headers('authorization') authorization: string | undefined,
    @Body()
    body: {
      companyId?: string;
      senderId?: string;
      text?: string;
      dryRun?: boolean;
    },
  ) {
    this.assertInternalToken(authorization);
    const companyId = body.companyId?.trim();
    const senderId = body.senderId?.trim();
    const text = body.text?.trim();

    if (!companyId || !senderId || !text) {
      throw new BadRequestException('companyId, senderId e text sao obrigatorios');
    }

    return this.instagramMessageProcessorService.processSyntheticMessage({
      companyId,
      senderId,
      text,
      dryRun: body.dryRun !== false,
    });
  }

  private assertInternalToken(authorization: string | undefined) {
    const expected = this.configService
      .get<string>('INTERNAL_AUTOMATION_TOKEN')
      ?.trim();
    const received = authorization?.replace(/^Bearer\s+/i, '').trim();

    if (!expected || !received || expected !== received) {
      throw new UnauthorizedException('Token interno invalido');
    }
  }

  private readQueryValue(value: unknown) {
    if (Array.isArray(value)) {
      const first = value.find((item) => typeof item === 'string' && item.trim());
      return typeof first === 'string' ? first.trim() : undefined;
    }

    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  }
}
