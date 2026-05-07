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
import { InstagramMessageProcessorService } from './instagram-message-processor.service';
import { InstagramWebhookService } from './instagram-webhook.service';

type InstagramWebhookRequest = Request & { rawBody?: Buffer };

@Controller('instagram')
export class InstagramWebhookController {
  constructor(
    private readonly configService: ConfigService,
    private readonly instagramWebhookService: InstagramWebhookService,
    private readonly instagramMessageProcessorService: InstagramMessageProcessorService,
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
