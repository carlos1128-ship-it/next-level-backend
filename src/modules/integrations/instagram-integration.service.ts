import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IntegrationAccount, IntegrationProvider, Prisma } from '@prisma/client';
import * as crypto from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { IntegrationsService } from './integrations.service';

type ResolveInstagramAccountInput = {
  instagramAccountId?: string | null;
  pageId?: string | null;
  recipientId?: string | null;
  entryId?: string | null;
};

export type InstagramAccountResolution = {
  account: IntegrationAccount | null;
  matched: boolean;
  matchedBy: string | null;
  recipientId: string | null;
  entryIdExists: boolean;
  candidates: string[];
  knownIdFieldsChecked: string[];
  unresolvedReason?: string;
};

@Injectable()
export class InstagramIntegrationService {
  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly integrationsService: IntegrationsService,
  ) {}

  async resolveAccountForWebhook(input: ResolveInstagramAccountInput) {
    return (await this.resolveAccountForWebhookDetailed(input)).account;
  }

  async resolveAccountForWebhookDetailed(
    input: ResolveInstagramAccountInput,
  ): Promise<InstagramAccountResolution> {
    const candidates = this.buildCandidates(input);
    const baseWhere = {
      provider: IntegrationProvider.INSTAGRAM,
      status: { not: 'disconnected' },
    } satisfies Prisma.IntegrationAccountWhereInput;

    for (const candidate of candidates) {
      const directChecks: Array<{
        matchedBy: string;
        where: Prisma.IntegrationAccountWhereInput;
      }> = [
        { matchedBy: 'instagramAccountId', where: { instagramAccountId: candidate } },
        { matchedBy: 'igBusinessId', where: { igBusinessId: candidate } },
        { matchedBy: 'pageId', where: { pageId: candidate } },
        {
          matchedBy: 'metadata.recipientId',
          where: { metadata: { path: ['recipientId'], equals: candidate } },
        },
        {
          matchedBy: 'metadata.instagramAccountId',
          where: { metadata: { path: ['instagramAccountId'], equals: candidate } },
        },
        {
          matchedBy: 'metadata.igUserId',
          where: { metadata: { path: ['igUserId'], equals: candidate } },
        },
        {
          matchedBy: 'metadata.id',
          where: { metadata: { path: ['id'], equals: candidate } },
        },
        {
          matchedBy: 'metadata.pageId',
          where: { metadata: { path: ['pageId'], equals: candidate } },
        },
        {
          matchedBy: 'metadata.webhookRecipientId',
          where: { metadata: { path: ['webhookRecipientId'], equals: candidate } },
        },
        {
          matchedBy: 'metadata.igBusinessId',
          where: { metadata: { path: ['igBusinessId'], equals: candidate } },
        },
        {
          matchedBy: 'metadata.providerAccountId',
          where: { metadata: { path: ['providerAccountId'], equals: candidate } },
        },
        {
          matchedBy: 'metadata.accountId',
          where: { metadata: { path: ['accountId'], equals: candidate } },
        },
      ];

      for (const check of directChecks) {
        const account = await this.prisma.integrationAccount.findFirst({
          where: { ...baseWhere, ...check.where },
        });
        if (account) {
          return this.match(input, candidates, account, check.matchedBy);
        }
      }

      const metadataMatch = await this.findByKnownMetadataId(baseWhere, candidate);
      if (metadataMatch) {
        return this.match(input, candidates, metadataMatch.account, metadataMatch.matchedBy);
      }

      const integration = await this.prisma.integration.findFirst({
        where: {
          provider: IntegrationProvider.INSTAGRAM,
          status: { not: 'disconnected' },
          externalId: candidate,
        },
        select: { companyId: true },
      });
      if (integration) {
        const account = await this.prisma.integrationAccount.findFirst({
          where: { ...baseWhere, companyId: integration.companyId },
        });
        if (account) {
          return this.match(input, candidates, account, 'integration.externalId');
        }
      }

      const company = await this.prisma.company.findFirst({
        where: { instagramAccountId: candidate },
        select: { id: true },
      });
      if (company) {
        const account = await this.prisma.integrationAccount.findFirst({
          where: { ...baseWhere, companyId: company.id },
        });
        if (account) {
          return this.match(input, candidates, account, 'company.instagramAccountId');
        }
      }
    }

    return {
      account: null,
      matched: false,
      matchedBy: null,
      recipientId: input.recipientId?.trim() || null,
      entryIdExists: Boolean(input.entryId?.trim()),
      candidates,
      knownIdFieldsChecked: this.knownIdFieldsChecked(),
      unresolvedReason: candidates.length
        ? 'no_instagram_account_matched'
        : 'missing_instagram_identifiers',
    };
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

  getKnownInstagramIds(account: Pick<
    IntegrationAccount,
    'instagramAccountId' | 'igBusinessId' | 'pageId' | 'metadata'
  > | null | undefined) {
    const metadata =
      account?.metadata && typeof account.metadata === 'object' && !Array.isArray(account.metadata)
        ? (account.metadata as Record<string, unknown>)
        : {};

    return [
      account?.instagramAccountId,
      account?.igBusinessId,
      account?.pageId,
      metadata.recipientId,
      metadata.instagramAccountId,
      metadata.igUserId,
      metadata.id,
      metadata.pageId,
      metadata.webhookRecipientId,
      metadata.igBusinessId,
      metadata.providerAccountId,
      metadata.accountId,
      ...(Array.isArray(metadata.allKnownInstagramIds)
        ? metadata.allKnownInstagramIds
        : []),
    ].reduce<string[]>((acc, item) => {
      const value = typeof item === 'number' ? String(item) : typeof item === 'string' ? item.trim() : '';
      if (value && !acc.includes(value)) acc.push(value);
      return acc;
    }, []);
  }

  encryptToken(token: string) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.getEncryptionKey(), iv);
    const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    return [
      'v1',
      iv.toString('base64url'),
      tag.toString('base64url'),
      encrypted.toString('base64url'),
    ].join(':');
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

  private buildCandidates(input: ResolveInstagramAccountInput) {
    return [
      input.recipientId,
      input.instagramAccountId,
      input.pageId,
      input.entryId,
    ].reduce<string[]>((acc, item) => {
      const value = item?.trim();
      if (value && !acc.includes(value)) acc.push(value);
      return acc;
    }, []);
  }

  private async findByKnownMetadataId(
    baseWhere: Prisma.IntegrationAccountWhereInput,
    candidate: string,
  ) {
    const accounts = await this.prisma.integrationAccount.findMany({
      where: baseWhere,
      take: 100,
    });

    for (const account of accounts) {
      const metadata =
        account.metadata && typeof account.metadata === 'object' && !Array.isArray(account.metadata)
          ? (account.metadata as Record<string, unknown>)
          : {};
      const fields: Array<[string, unknown]> = [
        ['metadata.webhookRecipientId', metadata.webhookRecipientId],
        ['metadata.igBusinessId', metadata.igBusinessId],
        ['metadata.recipientId', metadata.recipientId],
        ['metadata.instagramAccountId', metadata.instagramAccountId],
        ['metadata.igUserId', metadata.igUserId],
        ['metadata.id', metadata.id],
        ['metadata.pageId', metadata.pageId],
        ['metadata.providerAccountId', metadata.providerAccountId],
        ['metadata.accountId', metadata.accountId],
      ];

      for (const [matchedBy, value] of fields) {
        if (this.valueMatches(value, candidate)) {
          return { account, matchedBy };
        }
      }

      if (this.valueMatches(metadata.allKnownInstagramIds, candidate)) {
        return { account, matchedBy: 'metadata.allKnownInstagramIds' };
      }
    }

    return null;
  }

  private valueMatches(value: unknown, candidate: string): boolean {
    if (typeof value === 'number') return String(value) === candidate;
    if (typeof value === 'string') return value.trim() === candidate;
    if (Array.isArray(value)) {
      return value.some((item) => this.valueMatches(item, candidate));
    }
    return false;
  }

  private knownIdFieldsChecked() {
    return [
      'instagramAccountId',
      'igBusinessId',
      'pageId',
      'integration.externalId',
      'company.instagramAccountId',
      'metadata.recipientId',
      'metadata.instagramAccountId',
      'metadata.igUserId',
      'metadata.id',
      'metadata.pageId',
      'metadata.webhookRecipientId',
      'metadata.igBusinessId',
      'metadata.providerAccountId',
      'metadata.accountId',
      'metadata.allKnownInstagramIds',
    ];
  }

  private match(
    input: ResolveInstagramAccountInput,
    candidates: string[],
    account: IntegrationAccount,
    matchedBy: string,
  ): InstagramAccountResolution {
    return {
      account,
      matched: true,
      matchedBy,
      recipientId: input.recipientId?.trim() || null,
      entryIdExists: Boolean(input.entryId?.trim()),
      candidates,
      knownIdFieldsChecked: this.knownIdFieldsChecked(),
    };
  }
}
