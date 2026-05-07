import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IntegrationProvider, Prisma } from '@prisma/client';
import axios from 'axios';
import { PrismaService } from '../../prisma/prisma.service';
import { InstagramIntegrationService } from './instagram-integration.service';

type InstagramProviderError = {
  classification: string;
  status: number | null;
  message: string;
  type: string | null;
  code: number | null;
  subcode: number | null;
  fbtraceId: string | null;
};

type InstagramSendResult = {
  sent: boolean;
  provider: IntegrationProvider;
  endpointHost: string;
  endpointPathTemplate: string;
  igAccountId: string;
  recipientId: string;
  providerMessageId: string | null;
};

type ImportInstagramTokenInput = {
  companyId: string;
  instagramAccountId: string;
  username?: string | null;
  accessToken: string;
  tokenExpiresAt?: string | null;
  scopes?: string[];
};

@Injectable()
export class InstagramSendService {
  private readonly logger = new Logger(InstagramSendService.name);
  private readonly endpointHost = 'graph.instagram.com';
  private readonly refreshThresholdMs = 7 * 24 * 60 * 60 * 1000;

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly instagramIntegrationService: InstagramIntegrationService,
  ) {}

  async sendInstagramMessage(
    companyId: string,
    recipientId: string,
    text: string,
    options: { messageId?: string | null } = {},
  ): Promise<InstagramSendResult> {
    const credentials = await this.loadSendCredentials(companyId);
    const { account, igAccountId } = credentials;
    const endpointPathTemplate = this.getMessagesPathTemplate();
    let accessToken = credentials.accessToken;

    if (this.isTokenExpired(account?.tokenExpiry)) {
      const providerError = this.buildLocalProviderError(
        'TOKEN_EXPIRED_REAUTH_REQUIRED',
        'Token do Instagram expirado. Reconecte o Instagram ou importe um novo token.',
      );
      await this.markAccountReconnectRequired(companyId, 'token_expired');
      await this.markMessage(options.messageId, 'failed', providerError);
      throw new BadRequestException({
        message: providerError.message,
        classification: providerError.classification,
        providerError,
      });
    }

    try {
      if (!igAccountId || !accessToken) {
        throw this.buildLocalProviderError(
          !accessToken ? 'TOKEN_INVALID' : 'ENDPOINT_INVALID',
          'Conta Instagram sem credenciais de envio.',
        );
      }

      if (this.shouldRefreshBeforeSend(account?.tokenExpiry)) {
        const refresh = await this.refreshToken(companyId, accessToken, account?.id);
        accessToken = refresh.accessToken || accessToken;
      }

      const response = await axios.post<{
        message_id?: string;
        recipient_id?: string;
      }>(
        this.buildMessagesUrl(igAccountId),
        {
          recipient: { id: recipientId },
          message: { text },
        },
        {
          timeout: 10000,
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
        },
      );

      await this.markMessage(options.messageId, 'sent');
      return {
        sent: true,
        provider: IntegrationProvider.INSTAGRAM,
        endpointHost: this.endpointHost,
        endpointPathTemplate,
        igAccountId,
        recipientId,
        providerMessageId: response.data?.message_id || null,
      };
    } catch (error) {
      const providerError = this.normalizeProviderError(error);
      if (
        providerError.classification === 'TOKEN_EXPIRED' ||
        providerError.classification === 'TOKEN_EXPIRED_REAUTH_REQUIRED' ||
        providerError.classification === 'TOKEN_INVALID'
      ) {
        await this.markAccountReconnectRequired(
          companyId,
          providerError.classification === 'TOKEN_INVALID'
            ? 'reconnect_required'
            : 'token_expired',
        );
      }
      await this.markMessage(options.messageId, 'failed', providerError);
      this.logger.warn(
        JSON.stringify({
          event: 'instagram.dm.graph_api_error',
          companyId,
          status: providerError.status,
          error: {
            message: providerError.message,
            type: providerError.type,
            code: providerError.code,
            subcode: providerError.subcode,
          },
          classification: providerError.classification,
          fbtrace_id: providerError.fbtraceId,
          endpointHost: this.endpointHost,
          endpointPathTemplate,
          igAccountIdExists: Boolean(igAccountId),
          recipientIdExists: Boolean(recipientId),
          messageId: options.messageId || null,
        }),
      );
      this.logger.warn(
        JSON.stringify({
          event: 'instagram.dm.send_failed',
          companyId,
          recipientId,
          messageId: options.messageId || null,
          classification: providerError.classification,
          message: providerError.message,
        }),
      );
      throw new BadRequestException({
        message: providerError.message,
        classification: providerError.classification,
        providerError,
      });
    }
  }

  async getTokenStatus(companyId: string) {
    const account = await this.instagramIntegrationService.getActiveAccount(companyId);
    const encryptedToken = account?.pageAccessToken || null;
    const tokenExpired = this.isTokenExpired(account?.tokenExpiry);
    const scopesStored = this.readScopes(account?.metadata);
    const instagramAccountId =
      account?.instagramAccountId || account?.pageId || account?.igBusinessId || null;

    return {
      provider: 'instagram',
      connected: Boolean(account && account.status !== 'disconnected'),
      hasEncryptedToken: Boolean(encryptedToken),
      instagramAccountId,
      username: account?.igUsername || null,
      scopesStored,
      tokenExpiresAt: account?.tokenExpiry?.toISOString() || null,
      tokenExpired,
      status: account?.status || 'disconnected',
      canAttemptSend: Boolean(
        account &&
          encryptedToken &&
          instagramAccountId &&
          !tokenExpired &&
          !['token_expired', 'reconnect_required'].includes(account.status),
      ),
    };
  }

  async importToken(input: ImportInstagramTokenInput) {
    const companyId = input.companyId.trim();
    const instagramAccountId = input.instagramAccountId.trim();
    const accessToken = input.accessToken.trim();
    const username = input.username?.trim() || null;

    if (!companyId || !instagramAccountId || !accessToken) {
      throw new BadRequestException(
        'companyId, instagramAccountId e accessToken sao obrigatorios',
      );
    }

    const tokenExpiry = this.resolveImportedTokenExpiry(input.tokenExpiresAt);
    const encryptedToken = this.instagramIntegrationService.encryptToken(accessToken);
    const account = await this.instagramIntegrationService.getActiveAccount(companyId);
    const existingMetadata =
      account?.metadata && typeof account.metadata === 'object' && !Array.isArray(account.metadata)
        ? (account.metadata as Record<string, unknown>)
        : {};
    const scopes = this.normalizeScopes(input.scopes);
    const metadata = this.toJson({
      ...existingMetadata,
      scopes,
      recipientId: instagramAccountId,
      instagramAccountId,
      igUserId: instagramAccountId,
      id: instagramAccountId,
      tokenImportedAt: new Date().toISOString(),
    });

    const updatedAccount = await this.prisma.integrationAccount.upsert({
      where: {
        companyId_provider: {
          companyId,
          provider: IntegrationProvider.INSTAGRAM,
        },
      },
      update: {
        instagramAccountId,
        igBusinessId: account?.igBusinessId || instagramAccountId,
        igUsername: username || account?.igUsername,
        pageId: account?.pageId || instagramAccountId,
        pageAccessToken: encryptedToken,
        tokenExpiry,
        status: 'connected',
        metadata,
      },
      create: {
        companyId,
        provider: IntegrationProvider.INSTAGRAM,
        instagramAccountId,
        igBusinessId: instagramAccountId,
        igUsername: username,
        pageId: instagramAccountId,
        pageAccessToken: encryptedToken,
        tokenExpiry,
        status: 'connected',
        metadata,
      },
      select: {
        id: true,
        companyId: true,
        provider: true,
        instagramAccountId: true,
        igUsername: true,
        tokenExpiry: true,
        status: true,
        metadata: true,
      },
    });

    await Promise.all([
      this.prisma.integration.upsert({
        where: {
          companyId_provider: {
            companyId,
            provider: IntegrationProvider.INSTAGRAM,
          },
        },
        update: {
          accessToken: encryptedToken,
          externalId: instagramAccountId,
          status: 'connected',
        },
        create: {
          companyId,
          provider: IntegrationProvider.INSTAGRAM,
          accessToken: encryptedToken,
          externalId: instagramAccountId,
          status: 'connected',
        },
      }),
      this.prisma.company.update({
        where: { id: companyId },
        data: { instagramAccountId },
      }),
    ]);

    return {
      imported: true,
      connected: true,
      provider: 'instagram',
      integrationAccountId: updatedAccount.id,
      companyId: updatedAccount.companyId,
      instagramAccountId: updatedAccount.instagramAccountId,
      username: updatedAccount.igUsername,
      hasEncryptedToken: true,
      tokenExpiresAt: updatedAccount.tokenExpiry?.toISOString() || null,
      tokenExpired: this.isTokenExpired(updatedAccount.tokenExpiry),
      status: updatedAccount.status,
      scopesStored: this.readScopes(updatedAccount.metadata),
    };
  }

  async testSend(companyId: string, recipientId: string, text: string) {
    const endpointPathTemplate = this.getMessagesPathTemplate();
    let igAccountId = '';

    try {
      const credentials = await this.loadSendCredentials(companyId);
      igAccountId = credentials.igAccountId || '';
      const result = await this.sendInstagramMessage(companyId, recipientId, text);
      return {
        ok: true,
        endpointHost: result.endpointHost,
        endpointPathTemplate: result.endpointPathTemplate,
        igAccountId: result.igAccountId,
        recipientId,
        providerMessageId: result.providerMessageId,
      };
    } catch (error) {
      const providerError = this.readProviderErrorFromException(error);
      return {
        ok: false,
        endpointHost: this.endpointHost,
        endpointPathTemplate,
        igAccountId,
        recipientId,
        providerMessageId: null,
        providerError,
      };
    }
  }

  private async markMessage(
    messageId: string | null | undefined,
    status: string,
    providerError?: InstagramProviderError,
  ) {
    if (!messageId) return;

    await this.prisma.message
      .update({
        where: { id: messageId },
        data: {
          status,
          ...(providerError
            ? {
                metadata: this.toJson({
                  provider: 'instagram',
                  channel: 'instagram',
                  providerErrorCode: providerError.code,
                  providerErrorType: providerError.type,
                  providerErrorSubcode: providerError.subcode,
                  providerErrorMessage: this.truncate(providerError.message, 500),
                  providerErrorClassification: providerError.classification,
                  providerTraceId: providerError.fbtraceId,
                  providerStatus: providerError.status,
                }),
              }
            : {}),
        },
      })
      .catch(() => undefined);
  }

  private async loadSendCredentials(companyId: string) {
    const account = await this.instagramIntegrationService.getActiveAccount(companyId);
    let igAccountId =
      account?.instagramAccountId || account?.pageId || account?.igBusinessId || null;
    let encryptedToken = account?.pageAccessToken || null;

    if (!igAccountId || !encryptedToken) {
      const integration =
        await this.instagramIntegrationService.getActiveIntegration(companyId);
      igAccountId = igAccountId || integration.externalId;
      encryptedToken = encryptedToken || integration.accessToken;
    }

    const accessToken = encryptedToken
      ? this.instagramIntegrationService.decryptToken(encryptedToken)
      : null;

    return {
      account,
      igAccountId,
      accessToken,
      hasEncryptedToken: Boolean(encryptedToken),
    };
  }

  private async refreshToken(
    companyId: string,
    accessToken: string,
    integrationAccountId?: string | null,
  ) {
    this.logger.log(
      JSON.stringify({
        event: 'instagram.token.refresh.started',
        companyId,
        integrationAccountId: integrationAccountId || null,
      }),
    );

    try {
      const response = await axios.get<{
        access_token?: string;
        token_type?: string;
        expires_in?: number;
      }>(`https://${this.endpointHost}/refresh_access_token`, {
        timeout: 10000,
        params: {
          grant_type: 'ig_refresh_token',
          access_token: accessToken,
        },
      });
      const nextToken = response.data?.access_token;
      const expiresIn = Number(response.data?.expires_in || 0);

      if (!nextToken) {
        throw this.buildLocalProviderError(
          'UNKNOWN_META_ERROR',
          'Meta nao retornou novo token do Instagram.',
        );
      }

      const tokenExpiry = new Date(
        Date.now() + (expiresIn > 0 ? expiresIn : 60 * 24 * 60 * 60) * 1000,
      );
      const encryptedToken = this.instagramIntegrationService.encryptToken(nextToken);
      await Promise.all([
        this.prisma.integrationAccount.updateMany({
          where: {
            companyId,
            provider: IntegrationProvider.INSTAGRAM,
            status: { not: 'disconnected' },
          },
          data: {
            pageAccessToken: encryptedToken,
            tokenExpiry,
            status: 'connected',
          },
        }),
        this.prisma.integration.updateMany({
          where: {
            companyId,
            provider: IntegrationProvider.INSTAGRAM,
          },
          data: {
            accessToken: encryptedToken,
            status: 'connected',
          },
        }),
      ]);

      this.logger.log(
        JSON.stringify({
          event: 'instagram.token.refresh.succeeded',
          companyId,
          integrationAccountId: integrationAccountId || null,
          tokenExpiresAt: tokenExpiry.toISOString(),
        }),
      );

      return { refreshed: true, accessToken: nextToken, tokenExpiresAt: tokenExpiry };
    } catch (error) {
      const providerError = this.normalizeProviderError(error);
      const classification =
        providerError.classification === 'TOKEN_EXPIRED'
          ? 'TOKEN_EXPIRED_REAUTH_REQUIRED'
          : providerError.classification;
      this.logger.warn(
        JSON.stringify({
          event: 'instagram.token.refresh.failed',
          companyId,
          integrationAccountId: integrationAccountId || null,
          classification,
          status: providerError.status,
          code: providerError.code,
          type: providerError.type,
          fbtrace_id: providerError.fbtraceId,
        }),
      );
      if (classification === 'TOKEN_EXPIRED_REAUTH_REQUIRED') {
        await this.markAccountReconnectRequired(companyId, 'reconnect_required');
      }
      throw this.buildLocalProviderError(classification, providerError.message);
    }
  }

  private normalizeProviderError(error: unknown): InstagramProviderError {
    if (this.isInstagramProviderError(error)) return error;

    if (axios.isAxiosError(error)) {
      const rawError = this.readGraphError(error.response?.data);
      const status = error.response?.status || null;
      const message = this.truncate(
        rawError.message || error.message || 'Falha ao chamar Instagram Graph API.',
        500,
      );
      const providerError = {
        classification: this.classifyGraphError(status, rawError),
        status,
        message,
        type: rawError.type,
        code: rawError.code,
        subcode: rawError.subcode,
        fbtraceId: rawError.fbtraceId,
      };
      return providerError;
    }

    if (error instanceof BadRequestException) {
      const response = error.getResponse();
      if (
        response &&
        typeof response === 'object' &&
        !Array.isArray(response) &&
        'providerError' in response
      ) {
        const providerError = (response as { providerError?: unknown }).providerError;
        if (this.isInstagramProviderError(providerError)) return providerError;
      }
    }

    const message =
      error instanceof Error ? error.message : 'Falha ao chamar Instagram Graph API.';
    return this.buildLocalProviderError('UNKNOWN_META_ERROR', message);
  }

  private readProviderErrorFromException(error: unknown) {
    const providerError = this.normalizeProviderError(error);
    return {
      classification: providerError.classification,
      status: providerError.status,
      message: providerError.message,
      type: providerError.type,
      code: providerError.code,
      subcode: providerError.subcode,
      fbtraceId: providerError.fbtraceId,
    };
  }

  private buildLocalProviderError(
    classification: string,
    message: string,
  ): InstagramProviderError {
    return {
      classification,
      status: null,
      message: this.truncate(message, 500),
      type: null,
      code: null,
      subcode: null,
      fbtraceId: null,
    };
  }

  private readGraphError(data: unknown) {
    const container =
      data && typeof data === 'object' && !Array.isArray(data)
        ? (data as Record<string, unknown>).error
        : null;
    const error =
      container && typeof container === 'object' && !Array.isArray(container)
        ? (container as Record<string, unknown>)
        : {};

    return {
      message: typeof error.message === 'string' ? error.message : null,
      type: typeof error.type === 'string' ? error.type : null,
      code: typeof error.code === 'number' ? error.code : null,
      subcode: typeof error.error_subcode === 'number' ? error.error_subcode : null,
      fbtraceId: typeof error.fbtrace_id === 'string' ? error.fbtrace_id : null,
    };
  }

  private classifyGraphError(
    status: number | null,
    error: {
      message: string | null;
      type: string | null;
      code: number | null;
      subcode: number | null;
    },
  ) {
    const message = (error.message || '').toLowerCase();
    const type = (error.type || '').toLowerCase();

    if (status === 429 || error.code === 4 || error.code === 17 || error.code === 613) {
      return 'META_RATE_LIMIT';
    }
    if (status && status >= 500) return 'META_TEMPORARY_FAILURE';
    if (
      error.code === 190 ||
      message.includes('invalid oauth') ||
      message.includes('access token') ||
      message.includes('session has expired')
    ) {
      return message.includes('expired') ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID';
    }
    if (
      error.code === 10 ||
      error.code === 200 ||
      type.includes('permission') ||
      message.includes('permission') ||
      message.includes('permissions')
    ) {
      return 'PERMISSION_MISSING';
    }
    if (
      status === 404 ||
      error.code === 100 ||
      message.includes('unsupported post request') ||
      message.includes('unknown path')
    ) {
      return 'ENDPOINT_INVALID';
    }
    if (
      error.code === 551 ||
      message.includes('outside') ||
      message.includes('24') ||
      message.includes('messaging window')
    ) {
      return 'MESSAGING_WINDOW_CLOSED';
    }
    if (
      error.code === 9007 ||
      message.includes('recipient') ||
      message.includes('user not found')
    ) {
      return 'RECIPIENT_INVALID';
    }

    return 'UNKNOWN_META_ERROR';
  }

  private buildMessagesUrl(igAccountId: string) {
    return `https://${this.endpointHost}/v${this.getGraphVersion()}/${igAccountId}/messages`;
  }

  private buildMeUrl() {
    return `https://${this.endpointHost}/v${this.getGraphVersion()}/me`;
  }

  private getMessagesPathTemplate() {
    return `/v${this.getGraphVersion()}/{IG_ID}/messages`;
  }

  private getGraphVersion() {
    const version = this.configService.get<string>('META_GRAPH_VERSION') || '25.0';
    return version.replace(/^v/i, '') || '25.0';
  }

  private readScopes(metadata: unknown) {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return [];
    const item = metadata as Record<string, unknown>;
    const scopes = item.scopes || item.scope || item.permissions;
    if (Array.isArray(scopes)) {
      return scopes.filter((scope): scope is string => typeof scope === 'string');
    }
    if (typeof scopes === 'string') {
      return scopes
        .split(/[,\s]+/)
        .map((scope) => scope.trim())
        .filter(Boolean);
    }
    return [];
  }

  private normalizeScopes(scopes: string[] | undefined) {
    const defaults = [
      'instagram_business_basic',
      'instagram_business_manage_messages',
      'instagram_business_manage_comments',
    ];
    const allowed = new Set(defaults);
    const incoming = Array.isArray(scopes) ? scopes : [];
    return [...incoming, ...defaults]
      .map((scope) => scope.trim())
      .filter((scope, index, list) => allowed.has(scope) && list.indexOf(scope) === index);
  }

  private resolveImportedTokenExpiry(value: string | null | undefined) {
    if (value?.trim()) {
      const parsed = new Date(value);
      if (!Number.isNaN(parsed.getTime())) return parsed;
    }
    return new Date(Date.now() + 60 * 24 * 60 * 60 * 1000);
  }

  private isTokenExpired(value: Date | null | undefined) {
    return value instanceof Date && value.getTime() <= Date.now();
  }

  private shouldRefreshBeforeSend(value: Date | null | undefined) {
    return value instanceof Date && value.getTime() - Date.now() <= this.refreshThresholdMs;
  }

  private async markAccountReconnectRequired(companyId: string, status: string) {
    await Promise.all([
      this.prisma.integrationAccount.updateMany({
        where: {
          companyId,
          provider: IntegrationProvider.INSTAGRAM,
          status: { not: 'disconnected' },
        },
        data: { status },
      }),
      this.prisma.integration.updateMany({
        where: {
          companyId,
          provider: IntegrationProvider.INSTAGRAM,
        },
        data: { status },
      }),
    ]).catch(() => undefined);
  }

  private isInstagramProviderError(value: unknown): value is InstagramProviderError {
    return Boolean(
      value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        typeof (value as InstagramProviderError).classification === 'string' &&
        typeof (value as InstagramProviderError).message === 'string',
    );
  }

  private truncate(value: string, maxLength: number) {
    return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;
  }

  private toJson(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value ?? {})) as Prisma.InputJsonValue;
  }
}
