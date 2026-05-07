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
      },
    });

    return conversations.map((conversation) => {
      const lastMessage = conversation.messages[0];
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
        lastMessageAt: conversation.lastMessageAt.toISOString(),
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
        messages: conversation.messages.reverse(),
      };
    });
  }
}
