import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IntegrationProvider, Prisma } from '@prisma/client';
import * as crypto from 'crypto';
import { Request } from 'express';
import { PrismaService } from '../../prisma/prisma.service';
import { InstagramIntegrationService } from './instagram-integration.service';
import {
  InstagramMessageProcessorService,
  NormalizedInstagramMessage,
} from './instagram-message-processor.service';

type InstagramWebhookPayload = {
  object?: string;
  entry?: Array<Record<string, unknown>>;
};

@Injectable()
export class InstagramWebhookService {
  private readonly logger = new Logger(InstagramWebhookService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly instagramIntegrationService: InstagramIntegrationService,
    private readonly instagramMessageProcessorService: InstagramMessageProcessorService,
  ) {}

  verifyWebhookChallenge(query: {
    mode?: string;
    verifyToken?: string;
    challenge?: string;
  }) {
    const expected = this.configService
      .get<string>('INSTAGRAM_WEBHOOK_VERIFY_TOKEN')
      ?.trim();
    const tokenMatched = Boolean(
      query.verifyToken &&
        expected &&
        this.timingSafeEqual(query.verifyToken, expected),
    );

    this.logger.log(
      JSON.stringify({
        event: 'instagram.webhook.verify',
        modeReceived: query.mode || null,
        verifyTokenEnvExists: Boolean(expected),
        tokenMatched,
        challengeExists: Boolean(query.challenge),
      }),
    );

    if (query.mode === 'subscribe' && tokenMatched && query.challenge) {
      return query.challenge;
    }

    throw new ForbiddenException('Verificacao do webhook Instagram falhou');
  }

  async processWebhook(
    payload: InstagramWebhookPayload,
    req: Request & { rawBody?: Buffer },
  ) {
    this.assertValidSignature(req);

    if (!['instagram', 'instagram_business_account'].includes(payload?.object || '')) {
      return { received: true, ignored: true };
    }

    const messages = this.extractMessages(payload);
    let stored = 0;
    let queued = 0;
    let unresolved = 0;
    let duplicates = 0;
    let ignored = 0;

    for (const message of messages) {
      const resolution =
        await this.instagramIntegrationService.resolveAccountForWebhookDetailed({
          instagramAccountId: message.instagramAccountId,
          pageId: message.pageId,
          recipientId: message.recipientId,
          entryId: message.entryId,
        });
      const account = resolution.account;

      this.logger.log(
        JSON.stringify({
          event: 'instagram.company.resolve.started',
          recipientId: message.recipientId || null,
          entryId: message.entryId || null,
          entryIdExists: Boolean(message.entryId),
          knownIdFieldsChecked: resolution.knownIdFieldsChecked,
          matched: resolution.matched,
          matchedBy: resolution.matchedBy,
          companyId: account?.companyId || null,
          integrationAccountId: account?.id || null,
          unresolvedReason: resolution.unresolvedReason || null,
        }),
      );

      const existing = await this.prisma.integrationEvent.findUnique({
        where: {
          provider_externalId: {
            provider: IntegrationProvider.INSTAGRAM,
            externalId: message.messageId,
          },
        },
        select: { id: true },
      });

      if (existing) {
        duplicates += 1;
        continue;
      }

      const event = await this.prisma.integrationEvent.create({
        data: {
          companyId: account?.companyId || null,
          provider: IntegrationProvider.INSTAGRAM,
          type: 'instagram.message.received',
          externalId: message.messageId,
          status: account ? 'received' : 'unresolved',
          payload: this.toJson({
            normalized: message,
            rawObject: payload.object,
          }),
        },
      });
      stored += 1;

      if (!account) {
        unresolved += 1;
        await this.prisma.webhookLog
          .create({
            data: {
              companyId: null,
              provider: IntegrationProvider.INSTAGRAM,
              status: 'FAILED',
              eventId: event.id,
              message: 'Conta Instagram nao resolvida para webhook',
            },
          })
          .catch(() => undefined);
        this.logger.warn(
          JSON.stringify({
            event: 'instagram.webhook.unresolved_company',
            integrationEventId: event.id,
            instagramAccountId: message.instagramAccountId || null,
            recipientId: message.recipientId || null,
            entryId: message.entryId || null,
            entryIdExists: Boolean(message.entryId),
            unresolvedReason: resolution.unresolvedReason || null,
          }),
        );
        continue;
      }

      await this.prisma.webhookLog
        .create({
          data: {
            companyId: account.companyId,
            provider: IntegrationProvider.INSTAGRAM,
            status: 'SUCCESS',
            eventId: event.id,
            message: 'Evento Instagram recebido',
          },
        })
        .catch(() => undefined);

      setImmediate(() => {
        this.instagramMessageProcessorService
          .processIntegrationEvent(event.id)
          .catch((error) => {
            this.logger.warn(
              JSON.stringify({
                event: 'instagram.webhook.async_process_failed',
                integrationEventId: event.id,
                message:
                  error instanceof Error ? error.message : 'Falha ao processar evento',
              }),
            );
          });
      });
      queued += 1;
    }

    if (!messages.length) ignored += 1;

    return {
      received: true,
      stored,
      queued,
      unresolved,
      duplicates,
      ignored,
    };
  }

  private extractMessages(payload: InstagramWebhookPayload): NormalizedInstagramMessage[] {
    const entries = Array.isArray(payload.entry) ? payload.entry : [];
    const messages: NormalizedInstagramMessage[] = [];

    for (const entry of entries) {
      const entryId = this.readString(entry.id);
      const entryTime = this.readTimestamp(entry.time);
      const messaging = Array.isArray(entry.messaging) ? entry.messaging : [];

      for (const rawItem of messaging) {
        if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) {
          continue;
        }

        const item = rawItem as Record<string, unknown>;
        const senderId = this.readNestedString(item.sender, 'id');
        const recipientId = this.readNestedString(item.recipient, 'id');
        if (!senderId || !recipientId) continue;

        const messageObject =
          item.message && typeof item.message === 'object' && !Array.isArray(item.message)
            ? (item.message as Record<string, unknown>)
            : null;
        const messageId =
          this.readString(messageObject?.mid) ||
          this.readString(messageObject?.id) ||
          `instagram:${entryId || recipientId}:${senderId}:${this.readString(item.timestamp) || Date.now()}`;
        const text = this.readString(messageObject?.text) || '';
        const attachments = Array.isArray(messageObject?.attachments)
          ? messageObject?.attachments
          : [];
        const contentType = text
          ? 'text'
          : attachments.length
            ? 'attachment'
            : 'unsupported';

        messages.push({
          entryId,
          instagramAccountId: entryId || recipientId,
          pageId: recipientId,
          senderId,
          recipientId,
          messageId,
          text,
          timestamp: this.readTimestamp(item.timestamp) || entryTime || new Date().toISOString(),
          contentType,
          raw: item,
        });
      }
    }

    return messages;
  }

  private assertValidSignature(req: Request & { rawBody?: Buffer }) {
    const appSecret = this.configService.get<string>('META_APP_SECRET')?.trim();
    if (!appSecret) {
      throw new BadRequestException('META_APP_SECRET nao configurado');
    }

    const signature = this.readHeader(req, 'x-hub-signature-256');
    if (!signature?.startsWith('sha256=')) {
      throw new UnauthorizedException('Assinatura Instagram ausente');
    }

    const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
    const expected =
      'sha256=' +
      crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');

    if (!this.timingSafeEqual(signature, expected)) {
      throw new UnauthorizedException('Assinatura Instagram invalida');
    }
  }

  private readHeader(req: Request, name: string) {
    const value = req.headers[name.toLowerCase()];
    if (Array.isArray(value)) return value[0] || '';
    return typeof value === 'string' ? value : '';
  }

  private readNestedString(value: unknown, key: string) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return this.readString((value as Record<string, unknown>)[key]);
  }

  private readString(value: unknown) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    return null;
  }

  private readTimestamp(value: unknown) {
    const raw = this.readString(value);
    if (!raw) return null;
    const numeric = Number(raw);
    if (Number.isFinite(numeric)) {
      return new Date(numeric < 1000000000000 ? numeric * 1000 : numeric).toISOString();
    }

    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }

  private timingSafeEqual(left: string, right: string) {
    const leftBuffer = Buffer.from(left);
    const rightBuffer = Buffer.from(right);
    if (leftBuffer.length !== rightBuffer.length) return false;
    return crypto.timingSafeEqual(leftBuffer, rightBuffer);
  }

  private toJson(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value ?? {})) as Prisma.InputJsonValue;
  }
}
