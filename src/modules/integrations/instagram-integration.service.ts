import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IntegrationProvider } from '@prisma/client';
import * as crypto from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { IntegrationsService } from './integrations.service';

type ResolveInstagramAccountInput = {
  instagramAccountId?: string | null;
  pageId?: string | null;
  recipientId?: string | null;
};

@Injectable()
export class InstagramIntegrationService {
  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly integrationsService: IntegrationsService,
  ) {}

  async resolveAccountForWebhook(input: ResolveInstagramAccountInput) {
    const candidates = [
      input.instagramAccountId,
      input.recipientId,
      input.pageId,
    ]
      .map((item) => item?.trim())
      .filter(Boolean) as string[];

    if (!candidates.length) return null;

    return this.prisma.integrationAccount.findFirst({
      where: {
        provider: IntegrationProvider.INSTAGRAM,
        status: { not: 'disconnected' },
        OR: [
          { igBusinessId: { in: candidates } },
          { pageId: { in: candidates } },
        ],
      },
    });
  }

  async getActiveAccount(companyId: string) {
    return this.prisma.integrationAccount.findFirst({
      where: {
        companyId,
        provider: IntegrationProvider.INSTAGRAM,
        status: { not: 'disconnected' },
      },
    });
  }

  async getActiveIntegration(companyId: string) {
    return this.integrationsService.getActiveIntegration(
      companyId,
      IntegrationProvider.INSTAGRAM,
    );
  }

  decryptToken(value: string) {
    if (!value.startsWith('v1:')) {
      return value;
    }

    const [, ivRaw, tagRaw, encryptedRaw] = value.split(':');
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      this.getEncryptionKey(),
      Buffer.from(ivRaw, 'base64url'),
    );
    decipher.setAuthTag(Buffer.from(tagRaw, 'base64url'));

    return Buffer.concat([
      decipher.update(Buffer.from(encryptedRaw, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  }

  private getEncryptionKey() {
    const secret =
      this.configService.get<string>('INTEGRATION_TOKEN_ENCRYPTION_KEY')?.trim() ||
      this.configService.get<string>('META_APP_SECRET')?.trim();

    if (!secret) {
      throw new BadRequestException(
        'INTEGRATION_TOKEN_ENCRYPTION_KEY ou META_APP_SECRET precisa estar configurado.',
      );
    }

    return crypto.createHash('sha256').update(secret).digest();
  }
}
