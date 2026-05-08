import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IntegrationProvider } from '@prisma/client';
import { Public } from '../../common/decorators/public.decorator';
import { AttendantActionService } from './attendant-action.service';

@Controller('attendant/internal')
export class AttendantInternalController {
  constructor(
    private readonly configService: ConfigService,
    private readonly actionService: AttendantActionService,
  ) {}

  @Public()
  @Post('test-intent')
  testIntent(
    @Headers('authorization') authorization: string | undefined,
    @Body()
    body: {
      companyId?: string;
      channel?: string;
      conversationId?: string;
      text?: string;
      customerExternalId?: string;
      dryRun?: boolean;
    },
  ) {
    this.assertInternalToken(authorization);
    const companyId = body.companyId?.trim();
    const channel = body.channel?.trim() || 'instagram';
    const conversationId = body.conversationId?.trim() || null;
    const text = body.text?.trim();
    const customerExternalId = body.customerExternalId?.trim() || 'test-customer';
    const dryRun = body.dryRun !== false;

    if (!companyId || !text) {
      throw new BadRequestException('companyId e text sao obrigatorios');
    }
    if (!dryRun && !conversationId) {
      throw new BadRequestException('conversationId e obrigatorio quando dryRun=false');
    }

    return this.actionService.analyzeAndPrepare({
      companyId,
      conversationId,
      channel,
      provider: channel === 'instagram' ? IntegrationProvider.INSTAGRAM : IntegrationProvider.WHATSAPP,
      customerExternalId,
      text,
      dryRun,
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
}
