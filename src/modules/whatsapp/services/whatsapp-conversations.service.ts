import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma, WhatsappConnection } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { ListConversationsDto } from '../dto/list-conversations.dto';
import { WhatsappProviderEvolutionService } from './whatsapp-provider-evolution.service';

type EvolutionMessage = {
  pushName?: string;
  key?: {
    id?: string;
    fromMe?: boolean;
    remoteJid?: string;
  };
  message?: Record<string, unknown>;
  messageTimestamp?: string | number;
};

@Injectable()
export class WhatsappConversationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly providerService: WhatsappProviderEvolutionService,
  ) {}

  async list(companyId: string, query: ListConversationsDto) {
    const limit = Math.min(100, Math.max(1, query.limit || 20));

    return this.prisma.conversation.findMany({
      where: {
        companyId,
        status: query.status?.trim() || undefined,
      },
      include: {
        messages: {
          orderBy: { createdAt: 'asc' },
          take: 50,
        },
      },
      orderBy: { lastMessageAt: 'desc' },
      take: limit,
    });
  }

  async getById(companyId: string, conversationId: string) {
    const conversation = await this.prisma.conversation.findFirst({
      where: {
        id: conversationId,
        companyId,
      },
      include: {
        messages: {
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    if (!conversation) {
      throw new BadRequestException('Conversa nao encontrada para esta empresa');
    }

    return conversation;
  }

  async sendManualMessage(
    companyId: string,
    conversationId: string,
    content: string,
  ) {
    const conversation = await this.getById(companyId, conversationId);
    const connection = await this.prisma.whatsappConnection.findUnique({
      where: { companyId },
    });

    if (!connection || connection.status !== 'connected') {
      throw new BadRequestException('Conexao WhatsApp indisponivel para envio');
    }

    await this.providerService.sendTextMessage(
      connection.instanceName,
      conversation.contactNumber,
      content,
    );

    const now = new Date();

    await this.prisma.$transaction([
      this.prisma.message.create({
        data: {
          companyId,
          conversationId: conversation.id,
          direction: 'outbound',
          contentType: 'text',
          content: content.trim(),
          senderPhone: conversation.contactNumber,
          status: 'sent',
        },
      }),
      this.prisma.conversation.update({
        where: { id: conversation.id },
        data: {
          status: 'open',
          lastMessagePreview: content.trim(),
          lastMessageAt: now,
        },
      }),
      this.prisma.usageQuota.upsert({
        where: { companyId },
        update: {
          whatsappMessagesSent: { increment: 1 },
        },
        create: {
          companyId,
          currentTier: 'COMUM',
          billingCycleEnd: this.addDays(now, 30),
          whatsappMessagesSent: 1,
        },
      }),
    ]);

    return this.getById(companyId, conversationId);
  }

  async logAutomationMessage(payload: Record<string, unknown>) {
    const companyId = this.readString(payload.companyId);
    const remoteJid = this.readString(payload.remoteJid);

    if (!companyId || !remoteJid) {
      throw new BadRequestException('companyId e remoteJid sao obrigatorios');
    }

    const contentType = this.readString(payload.contentType) || 'text';
    const text =
      this.readString(payload.text) ||
      this.readString(payload.transcription) ||
      this.readString(payload.aiResponse) ||
      '';
    const direction = this.readString(payload.direction) === 'outbound'
      ? 'outbound'
      : 'inbound';
    const now = new Date();
    const remoteNumber = this.normalizeRemoteNumber(remoteJid);

    const conversation = await this.prisma.conversation.upsert({
      where: {
        companyId_contactNumber: {
          companyId,
          contactNumber: remoteNumber,
        },
      },
      update: {
        remoteJid,
        contactName: this.readString(payload.contactName) || undefined,
        botPaused:
          typeof payload.botPaused === 'boolean' ? payload.botPaused : undefined,
        lastMessagePreview: text || `[${contentType}]`,
        lastMessageAt: now,
      },
      create: {
        companyId,
        contactNumber: remoteNumber,
        remoteJid,
        contactName: this.readString(payload.contactName),
        botPaused: Boolean(payload.botPaused),
        lastMessagePreview: text || `[${contentType}]`,
        lastMessageAt: now,
      },
    });

    try {
      await this.prisma.message.create({
        data: {
          companyId,
          conversationId: conversation.id,
          externalMessageId: this.readString(payload.externalMessageId),
          direction,
          contentType,
          content: text,
          text: this.readString(payload.text),
          transcription: this.readString(payload.transcription),
          mediaUrl: this.readString(payload.mediaUrl),
          aiResponse: this.readString(payload.aiResponse),
          senderName: this.readString(payload.contactName),
          senderPhone: remoteNumber,
          status: direction === 'outbound' ? 'sent' : 'received',
          metadata: this.toJson(payload.metadata || payload),
          rawPayload: this.toJson(payload.rawPayload || payload),
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        return { conversationId: conversation.id, duplicate: true };
      }

      throw error;
    }

    if (direction === 'outbound') {
      await this.prisma.usageQuota.upsert({
        where: { companyId },
        update: {
          whatsappMessagesSent: { increment: 1 },
        },
        create: {
          companyId,
          currentTier: 'COMUM',
          billingCycleEnd: this.addDays(now, 30),
          whatsappMessagesSent: 1,
        },
      });
    }

    return { conversationId: conversation.id, logged: true };
  }

  async logConversationState(payload: Record<string, unknown>) {
    const companyId = this.readString(payload.companyId);
    const remoteJid = this.readString(payload.remoteJid);

    if (!companyId || !remoteJid) {
      throw new BadRequestException('companyId e remoteJid sao obrigatorios');
    }

    const remoteNumber = this.normalizeRemoteNumber(remoteJid);
    const conversation = await this.prisma.conversation.upsert({
      where: {
        companyId_contactNumber: {
          companyId,
          contactNumber: remoteNumber,
        },
      },
      update: {
        remoteJid,
        botPaused: Boolean(payload.botPaused),
        contactName: this.readString(payload.contactName) || undefined,
      },
      create: {
        companyId,
        contactNumber: remoteNumber,
        remoteJid,
        botPaused: Boolean(payload.botPaused),
        contactName: this.readString(payload.contactName),
      },
    });

    return { conversationId: conversation.id, botPaused: conversation.botPaused };
  }

  async ingestEvolutionMessages(
    connection: Pick<WhatsappConnection, 'companyId' | 'id'>,
    rawMessages: unknown[],
  ) {
    for (const rawMessage of rawMessages) {
      const parsed = this.parseEvolutionMessage(rawMessage);
      if (!parsed) {
        continue;
      }

      const timestamp = parsed.messageTimestamp || new Date();

      const conversation = await this.prisma.conversation.upsert({
        where: {
          companyId_contactNumber: {
            companyId: connection.companyId,
            contactNumber: parsed.remoteNumber,
          },
        },
        update: {
          contactName: parsed.pushName || undefined,
          status: 'open',
          lastMessagePreview: parsed.content,
          lastMessageAt: timestamp,
        },
        create: {
          companyId: connection.companyId,
          contactNumber: parsed.remoteNumber,
          contactName: parsed.pushName,
          status: 'open',
          lastMessagePreview: parsed.content,
          lastMessageAt: timestamp,
        },
      });

      try {
        await this.prisma.message.create({
          data: {
            companyId: connection.companyId,
            conversationId: conversation.id,
            externalMessageId: parsed.externalMessageId,
            direction: parsed.fromMe ? 'outbound' : 'inbound',
            contentType: parsed.contentType,
            content: parsed.content,
            text: parsed.contentType === 'text' ? parsed.content : null,
            mediaUrl: parsed.mediaUrl,
            senderName: parsed.pushName,
            senderPhone: parsed.remoteNumber,
            status: parsed.fromMe ? 'sent' : 'received',
            metadata: rawMessage as Prisma.InputJsonValue,
            rawPayload: rawMessage as Prisma.InputJsonValue,
            createdAt: timestamp,
            updatedAt: timestamp,
          },
        });
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002'
        ) {
          continue;
        }

        throw error;
      }
    }
  }

  private parseEvolutionMessage(rawMessage: unknown) {
    const message = rawMessage as EvolutionMessage;
    const externalMessageId = this.readString(message?.key?.id);
    const remoteJid = this.readString(message?.key?.remoteJid);
    const fromMe = Boolean(message?.key?.fromMe);

    if (!externalMessageId || !remoteJid || this.shouldIgnoreRemoteJid(remoteJid)) {
      return null;
    }

    const content = this.unwrapMessageContent(message.message);
    const text = this.extractText(content);
    const contentType = this.detectContentType(content);

    if (!text && contentType === 'text') {
      return null;
    }

    return {
      externalMessageId,
      remoteNumber: this.normalizeRemoteNumber(remoteJid),
      pushName: this.readString(message.pushName),
      fromMe,
      contentType,
      content: text || '[mensagem sem texto]',
      mediaUrl: this.extractMediaUrl(content),
      messageTimestamp: this.parseMessageTimestamp(message.messageTimestamp),
    };
  }

  private unwrapMessageContent(message: Record<string, unknown> | undefined) {
    let current = message || null;

    for (let depth = 0; depth < 5 && current; depth += 1) {
      const next =
        this.asRecord(current.ephemeralMessage)?.message ||
        this.asRecord(current.viewOnceMessage)?.message ||
        this.asRecord(current.viewOnceMessageV2)?.message ||
        this.asRecord(current.viewOnceMessageV2Extension)?.message;

      if (!next || typeof next !== 'object') {
        break;
      }

      current = next as Record<string, unknown>;
    }

    return current;
  }

  private extractText(content: Record<string, unknown> | null) {
    if (!content) {
      return null;
    }

    const directText = this.readString(content.conversation);
    if (directText) {
      return directText;
    }

    const extendedText = this.readString(
      this.asRecord(content.extendedTextMessage)?.text,
    );
    if (extendedText) {
      return extendedText;
    }

    const imageCaption = this.readString(
      this.asRecord(content.imageMessage)?.caption,
    );
    if (imageCaption) {
      return imageCaption;
    }

    const videoCaption = this.readString(
      this.asRecord(content.videoMessage)?.caption,
    );
    if (videoCaption) {
      return videoCaption;
    }

    const documentCaption = this.readString(
      this.asRecord(content.documentMessage)?.caption,
    );
    if (documentCaption) {
      return documentCaption;
    }

    const buttonReply = this.readString(
      this.asRecord(content.buttonsResponseMessage)?.selectedDisplayText,
    );
    if (buttonReply) {
      return buttonReply;
    }

    const listReply = this.readString(
      this.asRecord(content.listResponseMessage)?.title,
    );
    if (listReply) {
      return listReply;
    }

    return null;
  }

  private detectContentType(content: Record<string, unknown> | null) {
    if (!content) {
      return 'unknown';
    }

    if (content.imageMessage) return 'image';
    if (content.videoMessage) return 'video';
    if (content.audioMessage) return 'audio';
    if (content.documentMessage) return 'document';
    return 'text';
  }

  private extractMediaUrl(content: Record<string, unknown> | null) {
    if (!content) {
      return null;
    }

    const media =
      this.asRecord(content.imageMessage) ||
      this.asRecord(content.audioMessage) ||
      this.asRecord(content.videoMessage) ||
      this.asRecord(content.documentMessage);

    return (
      this.readString(media?.url) ||
      this.readString(media?.mediaUrl) ||
      this.readString(media?.directPath)
    );
  }

  private normalizeRemoteNumber(value: string) {
    return value
      .replace('@s.whatsapp.net', '')
      .replace('@c.us', '')
      .replace(/\D/g, '');
  }

  private shouldIgnoreRemoteJid(value: string) {
    return value.includes('@broadcast') || value.includes('@g.us');
  }

  private parseMessageTimestamp(value: unknown) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return new Date(value * 1000);
    }

    if (typeof value === 'string' && value.trim()) {
      const numeric = Number(value);
      if (Number.isFinite(numeric)) {
        return new Date(numeric * 1000);
      }

      const parsed = new Date(value);
      if (!Number.isNaN(parsed.getTime())) {
        return parsed;
      }
    }

    return null;
  }

  private readString(value: unknown) {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  }

  private asRecord(value: unknown) {
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  }

  private toJson(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value ?? {})) as Prisma.InputJsonValue;
  }

  private addDays(date: Date, days: number) {
    const next = new Date(date);
    next.setUTCDate(next.getUTCDate() + days);
    return next;
  }
}
