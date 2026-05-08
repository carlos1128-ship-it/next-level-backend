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
import { PrismaService } from '../../prisma/prisma.service';
import { AttendantActionService } from './attendant-action.service';

@Controller('attendant/internal')
export class AttendantInternalController {
  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly actionService: AttendantActionService,
  ) {}

  @Public()
  @Post('test-intent')
  async testIntent(
    @Headers('authorization') authorization: string | undefined,
    @Body()
    body: {
      companyId?: string;
      channel?: string;
      conversationId?: string;
      text?: string;
      customerExternalId?: string;
      provider?: string;
      dryRun?: boolean;
    },
  ) {
    this.assertInternalToken(authorization);
    const companyId = body.companyId?.trim();
    const channel = body.channel?.trim() || 'instagram';
    const provider = this.resolveProvider(body.provider || channel);
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

    if (!dryRun && conversationId) {
      await this.ensureTestConversation({
        id: conversationId,
        companyId,
        channel,
        provider,
        customerExternalId,
      });
    }

    return this.actionService.analyzeAndPrepare({
      companyId,
      conversationId,
      channel,
      provider,
      customerExternalId,
      text,
      dryRun,
    });
  }

  private resolveProvider(provider: string) {
    const normalized = provider.trim().toUpperCase();
    if (normalized === 'INSTAGRAM') {
      return IntegrationProvider.INSTAGRAM;
    }
    if (normalized === 'WHATSAPP') {
      return IntegrationProvider.WHATSAPP;
    }
    throw new BadRequestException('provider invalido');
  }

  private async ensureTestConversation(input: {
    id: string;
    companyId: string;
    channel: string;
    provider: IntegrationProvider;
    customerExternalId: string;
  }) {
    const existing = await this.prisma.conversation.findUnique({
      where: { id: input.id },
      select: { id: true, companyId: true },
    });

    if (existing && existing.companyId !== input.companyId) {
      throw new BadRequestException('conversationId pertence a outra empresa');
    }

    await this.prisma.conversation.upsert({
      where: { id: input.id },
      update: {
        channel: input.channel,
        provider: input.provider,
        contactNumber: input.customerExternalId,
        lastMessagePreview: 'Teste interno de intencao IA',
        lastMessageAt: new Date(),
      },
      create: {
        id: input.id,
        companyId: input.companyId,
        channel: input.channel,
        provider: input.provider,
        contactNumber: input.customerExternalId,
        externalThreadId: input.id,
        contactName: 'Teste IA',
        status: 'Teste interno',
        lastMessagePreview: 'Teste interno de intencao IA',
        lastMessageAt: new Date(),
      },
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
