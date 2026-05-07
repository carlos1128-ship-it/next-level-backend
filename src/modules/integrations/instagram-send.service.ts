import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { IntegrationProvider } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { InstagramIntegrationService } from './instagram-integration.service';
import { MetaGraphService } from './meta-graph.service';

@Injectable()
export class InstagramSendService {
  private readonly logger = new Logger(InstagramSendService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly instagramIntegrationService: InstagramIntegrationService,
    private readonly metaGraphService: MetaGraphService,
  ) {}

  async sendInstagramMessage(
    companyId: string,
    recipientId: string,
    text: string,
    options: { messageId?: string | null } = {},
  ) {
    const account = await this.instagramIntegrationService.getActiveAccount(companyId);
    const tokenExpired =
      account?.tokenExpiry instanceof Date &&
      account.tokenExpiry.getTime() <= Date.now();

    if (tokenExpired) {
      await this.markMessage(options.messageId, 'failed', 'instagram_token_expired');
      throw new BadRequestException('Token do Instagram expirado.');
    }

    const targetId = account?.igBusinessId || account?.pageId;
    const encryptedToken = account?.pageAccessToken;

    let graphTargetId = targetId;
    let accessToken = encryptedToken
      ? this.instagramIntegrationService.decryptToken(encryptedToken)
      : null;

    if (!graphTargetId || !accessToken) {
      const integration = await this.instagramIntegrationService.getActiveIntegration(companyId);
      graphTargetId = integration.externalId;
      accessToken = this.instagramIntegrationService.decryptToken(integration.accessToken);
    }

    try {
      await this.metaGraphService.requestWithRetry({
        companyId,
        method: 'POST',
        path: `${graphTargetId}/messages`,
        accessToken,
        data: {
          messaging_type: 'RESPONSE',
          recipient: { id: recipientId },
          message: { text },
        },
      });

      await this.markMessage(options.messageId, 'sent');
      return { sent: true, provider: IntegrationProvider.INSTAGRAM };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Falha ao enviar DM Instagram';
      await this.markMessage(options.messageId, 'failed', message);
      this.logger.warn(
        JSON.stringify({
          event: 'instagram.dm.send_failed',
          companyId,
          recipientId,
          messageId: options.messageId || null,
          message,
        }),
      );
      throw error;
    }
  }

  private async markMessage(
    messageId: string | null | undefined,
    status: string,
    errorMessage?: string,
  ) {
    if (!messageId) return;

    await this.prisma.message
      .update({
        where: { id: messageId },
        data: {
          status,
          ...(errorMessage
            ? {
                metadata: {
                  sendError: errorMessage,
                  channel: 'instagram',
                },
              }
            : {}),
        },
      })
      .catch(() => undefined);
  }
}
