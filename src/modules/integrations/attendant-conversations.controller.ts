import { BadRequestException, Controller, Get, Query, Req } from '@nestjs/common';
import { IntegrationProvider } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

const HISTORY_LIMIT = 10;

@Controller('attendant/conversations')
export class AttendantConversationsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async listConversations(
    @Req() req: { user?: { companyId?: string | null } },
    @Query('companyId') companyId?: string,
    @Query('limit') limit?: string,
  ) {
    const resolvedCompanyId = companyId?.trim() || req.user?.companyId?.trim();
    if (!resolvedCompanyId) {
      throw new BadRequestException('companyId e obrigatorio');
    }

    const take = Math.min(50, Math.max(1, Number(limit) || 20));
    const conversations = await this.prisma.conversation.findMany({
      where: {
        companyId: resolvedCompanyId,
        provider: {
          in: [IntegrationProvider.WHATSAPP, IntegrationProvider.INSTAGRAM],
        },
      },
      orderBy: { updatedAt: 'desc' },
      take,
      include: {
        messages: {
          orderBy: { timestamp: 'desc' },
          take: HISTORY_LIMIT,
        },
        appointmentRequests: {
          orderBy: { updatedAt: 'desc' },
          take: 3,
        },
        businessActionRequests: {
          orderBy: { updatedAt: 'desc' },
          take: 3,
        },
      },
    });

    return conversations.map((conversation) => {
      const lastMessage = conversation.messages[0];
      const metadata = this.readMetadataRecord(lastMessage?.metadata);
      const request = conversation.appointmentRequests[0];
      const action = conversation.businessActionRequests[0];
      return {
        id: conversation.id,
        companyId: conversation.companyId,
        whatsappConnectionId: conversation.whatsappConnectionId,
        provider: conversation.provider,
        channel: conversation.channel,
        remoteJid: conversation.remoteJid,
        contactName: conversation.contactName,
        contactNumber: conversation.contactNumber,
        externalThreadId: conversation.externalThreadId,
        externalAccountId: conversation.externalAccountId,
        status: conversation.status,
        botPaused: conversation.botPaused || conversation.isPaused,
        lastMessage: lastMessage?.content || conversation.lastMessagePreview || '',
        lastMessageDirection: lastMessage?.direction || null,
        lastMessageStatus: lastMessage?.status || null,
        intent: this.readString(metadata.intent) || action?.type || null,
        actionStatus:
          this.readString(metadata.actionStatus) || action?.status || request?.status || null,
        businessActionRequest: action || null,
        businessActionRequests: conversation.businessActionRequests,
        appointmentRequest: request || null,
        appointmentRequests: conversation.appointmentRequests,
        lastMessageAt: conversation.lastMessageAt.toISOString(),
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
        messages: conversation.messages.reverse(),
      };
    });
  }

  private readMetadataRecord(value: unknown) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return {};
    }

    return value as Record<string, unknown>;
  }

  private readString(value: unknown) {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  }
}
