import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { IntegrationProvider, Prisma } from '@prisma/client';
import axios from 'axios';
import * as crypto from 'crypto';
import { Request } from 'express';
import { PrismaService } from '../../prisma/prisma.service';
import { IntegrationsService } from './integrations.service';
import { MetaGraphService } from './meta-graph.service';

type SignedOAuthState = {
  companyId: string;
  userId?: string | null;
  returnTo: string;
  issuedAt: string;
};

type MetaPage = {
  id?: string;
  name?: string;
  access_token?: string;
  instagram_business_account?: {
    id?: string;
    username?: string;
  };
};

type InstagramWebhookPayload = {
  object?: string;
  entry?: Array<{
    id?: string;
    time?: number;
    messaging?: unknown[];
  }>;
};

type InstagramOAuthTokenResponse = {
  access_token?: string;
  user_id?: string | number;
};

type InstagramOAuthConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  authorizeUrl: string;
  authorizeUrlHost: string;
  scope: string;
};

@Injectable()
export class InstagramService {
  private readonly logger = new Logger(InstagramService.name);
  private readonly graphBaseUrl: string;
  private readonly graphVersion: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly integrationsService: IntegrationsService,
    private readonly metaGraphService: MetaGraphService,
  ) {
    this.graphBaseUrl =
      this.configService.get<string>('META_GRAPH_BASE_URL')?.trim() ||
      'https://graph.facebook.com';
    this.graphVersion = (
      this.configService.get<string>('META_GRAPH_API_VERSION')?.trim() ||
      this.configService.get<string>('META_GRAPH_VERSION')?.trim() ||
      '20.0'
    ).replace(/^v/i, '');
  }

  async buildConnectUrl(input: {
    companyId: string;
    userId?: string | null;
    returnTo?: string | null;
  }) {
    const oauthConfig = this.validateInstagramOAuthConfig();
    const state = this.signState({
      companyId: input.companyId,
      userId: input.userId || null,
      returnTo: this.resolveReturnTo(input.returnTo),
      issuedAt: new Date().toISOString(),
    }, oauthConfig.clientSecret);

    const url = new URL(oauthConfig.authorizeUrl);
    url.searchParams.set('client_id', oauthConfig.clientId);
    url.searchParams.set('redirect_uri', oauthConfig.redirectUri);
    url.searchParams.set('scope', oauthConfig.scope);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('state', state);

    const authUrl = url.toString();
    const developmentDebug =
      process.env.NODE_ENV !== 'production'
        ? {
            generatedOAuthUrl: this.redactOAuthState(authUrl),
          }
        : undefined;

    return {
      provider: 'instagram',
      authUrl,
      callbackUrl: oauthConfig.redirectUri,
      mode: 'oauth' as const,
      ...(developmentDebug ? { debug: developmentDebug } : {}),
    };
  }

  async handleOAuthCallback(code: string, stateRaw: string) {
    if (!code?.trim()) {
      throw new BadRequestException('Codigo OAuth nao informado');
    }

    const state = this.verifyState(stateRaw);
    const tokenResult = await this.exchangeCodeForToken(code.trim());
    const account = await this.discoverInstagramAccount(tokenResult);
    const encryptedPageToken = this.encryptToken(account.accessToken);
    const tokenExpiry = this.calculateTokenExpiry();

    await this.prisma.$transaction([
      this.prisma.integrationAccount.upsert({
        where: {
          companyId_provider: {
            companyId: state.companyId,
            provider: IntegrationProvider.INSTAGRAM,
          },
        },
        update: {
          igBusinessId: account.igBusinessId,
          igUsername: account.igUsername,
          pageId: account.pageId,
          pageName: account.pageName,
          pageAccessToken: encryptedPageToken,
          tokenExpiry,
          status: 'connected',
        },
        create: {
          companyId: state.companyId,
          provider: IntegrationProvider.INSTAGRAM,
          igBusinessId: account.igBusinessId,
          igUsername: account.igUsername,
          pageId: account.pageId,
          pageName: account.pageName,
          pageAccessToken: encryptedPageToken,
          tokenExpiry,
          status: 'connected',
        },
      }),
      this.prisma.integration.upsert({
        where: {
          companyId_provider: {
            companyId: state.companyId,
            provider: IntegrationProvider.INSTAGRAM,
          },
        },
        update: {
          accessToken: encryptedPageToken,
          externalId: account.igBusinessId,
          status: 'connected',
        },
        create: {
          companyId: state.companyId,
          provider: IntegrationProvider.INSTAGRAM,
          accessToken: encryptedPageToken,
          externalId: account.igBusinessId,
          status: 'connected',
        },
      }),
    ]);

    const subscription = account.pageId
      ? await this.subscribePageToInstagramMessages({
          companyId: state.companyId,
          pageId: account.pageId,
          pageAccessToken: account.accessToken,
        })
      : {
          success: true,
          skipped: true,
          reason: 'instagram_login_app_webhook',
        };

    this.logger.log(
      JSON.stringify({
        event: 'instagram.oauth.connected',
        companyId: state.companyId,
        pageId: account.pageId,
        igBusinessId: account.igBusinessId,
        subscribed: subscription.success,
        instagramLogin: !account.pageId,
      }),
    );

    return {
      companyId: state.companyId,
      returnTo: state.returnTo,
      connected: true,
      igBusinessId: account.igBusinessId,
      igUsername: account.igUsername,
      subscription,
    };
  }

  async getStatus(companyId: string) {
    const account = await this.prisma.integrationAccount.findFirst({
      where: {
        companyId,
        provider: IntegrationProvider.INSTAGRAM,
      },
      select: {
        igBusinessId: true,
        igUsername: true,
        pageId: true,
        pageName: true,
        tokenExpiry: true,
        status: true,
        updatedAt: true,
      },
    });

    if (!account || account.status === 'disconnected') {
      return {
        connected: false,
        status: 'disconnected',
        provider_setup_required: !this.hasOAuthConfig(),
      };
    }

    const expired =
      account.tokenExpiry instanceof Date && account.tokenExpiry.getTime() <= Date.now();

    return {
      connected: !expired,
      status: expired ? 'token_expired' : account.status,
      provider_setup_required: !this.hasOAuthConfig(),
      igBusinessId: account.igBusinessId,
      igUsername: account.igUsername,
      pageId: account.pageId,
      pageName: account.pageName,
      tokenExpiry: account.tokenExpiry,
      updatedAt: account.updatedAt,
    };
  }

  async disconnect(companyId: string) {
    await this.prisma.$transaction([
      this.prisma.integrationAccount.updateMany({
        where: { companyId, provider: IntegrationProvider.INSTAGRAM },
        data: {
          status: 'disconnected',
          pageAccessToken: null,
        },
      }),
      this.prisma.integration.updateMany({
        where: { companyId, provider: IntegrationProvider.INSTAGRAM },
        data: {
          status: 'disconnected',
          accessToken: '',
        },
      }),
    ]);

    return { disconnected: true };
  }

  verifyWebhookChallenge(query: {
    mode?: string;
    verifyToken?: string;
    challenge?: string;
  }) {
    const expected = process.env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN?.trim();
    const tokenMatched = Boolean(
      query.verifyToken &&
        expected &&
        this.timingSafeEqual(query.verifyToken, expected),
    );
    const challengeExists = Boolean(query.challenge);

    this.logger.log(
      JSON.stringify({
        event: 'instagram.webhook.verify',
        modeReceived: query.mode || null,
        verifyTokenEnvExists: Boolean(expected),
        tokenMatched,
        challengeExists,
      }),
    );

    if (
      query.mode === 'subscribe' &&
      tokenMatched &&
      challengeExists
    ) {
      return query.challenge as string;
    }

    throw new ForbiddenException('Verificacao do webhook Instagram falhou');
  }

  async processWebhook(
    payload: InstagramWebhookPayload,
    req: Request & { rawBody?: Buffer },
  ) {
    this.assertValidSignature(req);

    if (payload?.object !== 'instagram') {
      return { received: true, ignored: true };
    }

    const entries = Array.isArray(payload.entry) ? payload.entry : [];
    let processed = 0;
    let ignored = 0;

    for (const entry of entries) {
      const igBusinessId = entry.id?.trim();
      if (!igBusinessId) {
        ignored += 1;
        continue;
      }

      const account = await this.prisma.integrationAccount.findFirst({
        where: {
          provider: IntegrationProvider.INSTAGRAM,
          igBusinessId,
          status: { not: 'disconnected' },
        },
        select: {
          companyId: true,
        },
      });

      if (!account) {
        ignored += 1;
        await this.logWebhookFailure(null, payload, 'Conta Instagram nao encontrada');
        continue;
      }

      await this.prisma.integrationEvent.create({
        data: {
          companyId: account.companyId,
          provider: IntegrationProvider.INSTAGRAM,
          type: 'message_received',
          payload: payload as Prisma.InputJsonValue,
        },
      });

      const webhookEvent = await this.prisma.webhookEvent.create({
        data: {
          companyId: account.companyId,
          provider: IntegrationProvider.INSTAGRAM,
          payload: payload as Prisma.InputJsonValue,
        },
      });

      await this.prisma.webhookLog.create({
        data: {
          companyId: account.companyId,
          provider: IntegrationProvider.INSTAGRAM,
          status: 'SUCCESS',
          eventId: webhookEvent.id,
          message: 'Evento Instagram recebido',
        },
      });

      this.eventEmitter.emit('webhooks.received', {
        eventId: webhookEvent.id,
        provider: IntegrationProvider.INSTAGRAM,
        companyId: account.companyId,
      });
      processed += 1;
    }

    return { received: true, processed, ignored };
  }

  async sendDm(companyId: string, recipientId: string, message: string) {
    const account = await this.prisma.integrationAccount.findFirst({
      where: {
        companyId,
        provider: IntegrationProvider.INSTAGRAM,
        status: { not: 'disconnected' },
      },
    });

    if (account?.pageId && account.pageAccessToken) {
      await this.metaGraphService.requestWithRetry({
        companyId,
        method: 'POST',
        path: `${account.pageId}/messages`,
        accessToken: this.decryptToken(account.pageAccessToken),
        data: {
          messaging_type: 'RESPONSE',
          recipient: { id: recipientId },
          message: { text: message },
        },
      });

      return { sent: true };
    }

    const integration = await this.integrationsService.getActiveIntegration(
      companyId,
      IntegrationProvider.INSTAGRAM,
    );

    await this.metaGraphService.requestWithRetry({
      companyId,
      method: 'POST',
      path: `${integration.externalId}/messages`,
      accessToken: this.decryptToken(integration.accessToken),
      data: {
        messaging_type: 'RESPONSE',
        recipient: { id: recipientId },
        message: { text: message },
      },
    });

    return { sent: true };
  }

  private async exchangeCodeForToken(code: string): Promise<{
    accessToken: string;
    userId: string | null;
  }> {
    const clientId = this.readMetaAppIdForTokenExchange();
    const clientSecret = this.readRequiredConfig('META_APP_SECRET');
    const tokenUrl =
      process.env.INSTAGRAM_OAUTH_TOKEN_URL?.trim() ||
      'https://api.instagram.com/oauth/access_token';
    const callbackUrl = this.getCallbackUrl();
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'authorization_code',
      redirect_uri: callbackUrl,
      code,
    });

    const { data } = await axios.post<InstagramOAuthTokenResponse>(
      tokenUrl,
      body,
      {
        timeout: 10000,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      },
    );

    if (!data.access_token) {
      throw new BadRequestException('Instagram nao retornou access_token');
    }

    return {
      accessToken: data.access_token,
      userId:
        data.user_id === undefined || data.user_id === null
          ? null
          : String(data.user_id),
    };
  }

  private async discoverInstagramAccount(tokenResult: {
    accessToken: string;
    userId: string | null;
  }) {
    if (tokenResult.userId) {
      const profile = await this.fetchInstagramLoginProfile(
        tokenResult.userId,
        tokenResult.accessToken,
      ).catch(() => null);

      return {
        igBusinessId: tokenResult.userId,
        igUsername: profile?.username || null,
        pageId: null,
        pageName: null,
        accessToken: tokenResult.accessToken,
      };
    }

    const page = await this.discoverInstagramPage(tokenResult.accessToken);
    return {
      igBusinessId: page.igBusinessId,
      igUsername: page.igUsername,
      pageId: page.pageId,
      pageName: page.pageName,
      accessToken: page.pageAccessToken,
    };
  }

  private async fetchInstagramLoginProfile(userId: string, accessToken: string) {
    const { data } = await axios.get<{ username?: string }>(
      `https://graph.instagram.com/v${this.graphVersion}/${userId}`,
      {
        params: {
          fields: 'username',
          access_token: accessToken,
        },
        timeout: 10000,
      },
    );

    return data;
  }

  private async discoverInstagramPage(userAccessToken: string) {
    const { data } = await axios.get<{ data?: MetaPage[] }>(
      `${this.graphBaseUrl}/v${this.graphVersion}/me/accounts`,
      {
        params: {
          fields:
            'id,name,access_token,instagram_business_account{id,username}',
          access_token: userAccessToken,
        },
        timeout: 10000,
      },
    );
    const pages = Array.isArray(data.data) ? data.data : [];
    const page = pages.find((item) => item.instagram_business_account?.id);
    const ig = page?.instagram_business_account;

    if (!page?.id || !page.access_token || !ig?.id) {
      throw new BadRequestException(
        'Nenhuma Pagina do Facebook com Instagram Business vinculado foi encontrada.',
      );
    }

    return {
      pageId: page.id,
      pageName: page.name || null,
      pageAccessToken: page.access_token,
      igBusinessId: ig.id,
      igUsername: ig.username || null,
    };
  }

  private async subscribePageToInstagramMessages(input: {
    companyId: string;
    pageId: string;
    pageAccessToken: string;
  }) {
    try {
      await this.metaGraphService.requestWithRetry({
        companyId: input.companyId,
        method: 'POST',
        path: `${input.pageId}/subscribed_apps`,
        accessToken: input.pageAccessToken,
        params: {
          subscribed_fields: 'messages,messaging_postbacks,message_reactions',
        },
      });

      return { success: true };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Falha ao assinar webhooks';
      this.logger.warn(
        JSON.stringify({
          event: 'instagram.webhook.subscribe_failed',
          companyId: input.companyId,
          pageId: input.pageId,
          message,
        }),
      );
      return { success: false, message };
    }
  }

  private assertValidSignature(req: Request & { rawBody?: Buffer }) {
    const appSecret = this.readRequiredConfig('META_APP_SECRET');
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

  private encryptToken(token: string) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.getEncryptionKey(), iv);
    const encrypted = Buffer.concat([
      cipher.update(token, 'utf8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();

    return [
      'v1',
      iv.toString('base64url'),
      tag.toString('base64url'),
      encrypted.toString('base64url'),
    ].join(':');
  }

  private decryptToken(value: string) {
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

  private signState(payload: SignedOAuthState, appSecret?: string) {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = crypto
      .createHmac('sha256', appSecret || this.readRequiredConfig('META_APP_SECRET'))
      .update(body)
      .digest('base64url');
    return `${body}.${signature}`;
  }

  private verifyState(raw: string | undefined) {
    if (!raw?.trim()) {
      throw new BadRequestException('state OAuth nao informado');
    }

    const [body, signature] = raw.split('.');
    if (!body || !signature) {
      throw new BadRequestException('state OAuth invalido');
    }

    const expected = crypto
      .createHmac('sha256', this.readRequiredConfig('META_APP_SECRET'))
      .update(body)
      .digest('base64url');

    if (!this.timingSafeEqual(signature, expected)) {
      throw new BadRequestException('state OAuth invalido');
    }

    const parsed = JSON.parse(
      Buffer.from(body, 'base64url').toString('utf8'),
    ) as Partial<SignedOAuthState>;

    if (!parsed.companyId) {
      throw new BadRequestException('companyId ausente no state OAuth');
    }

    return {
      companyId: parsed.companyId,
      userId: parsed.userId || null,
      returnTo: this.resolveReturnTo(parsed.returnTo),
      issuedAt: parsed.issuedAt || new Date().toISOString(),
    };
  }

  private timingSafeEqual(left: string, right: string) {
    const leftBuffer = Buffer.from(left);
    const rightBuffer = Buffer.from(right);
    if (leftBuffer.length !== rightBuffer.length) {
      return false;
    }
    return crypto.timingSafeEqual(leftBuffer, rightBuffer);
  }

  private getCallbackUrl() {
    const configured =
      this.configService.get<string>('INSTAGRAM_REDIRECT_URI')?.trim() ||
      this.configService.get<string>('CALLBACK_URL')?.trim() ||
      this.configService.get<string>('INSTAGRAM_CALLBACK_URL')?.trim();

    if (configured) {
      return configured;
    }

    const publicApi =
      this.configService.get<string>('PUBLIC_API_URL')?.trim() ||
      this.configService.get<string>('APP_URL')?.trim() ||
      'http://localhost:3333/api';
    const normalized = publicApi.replace(/\/+$/, '');
    const apiBase = /\/api$/i.test(normalized) ? normalized : `${normalized}/api`;
    return `${apiBase}/instagram/callback`;
  }

  private resolveReturnTo(raw: string | null | undefined) {
    const frontend =
      this.configService.get<string>('FRONTEND_APP_URL')?.trim() ||
      'http://localhost:5173';
    const fallback = new URL('/integrations', frontend).toString();
    if (!raw?.trim()) return fallback;

    try {
      const incoming = new URL(raw);
      if (incoming.origin !== new URL(frontend).origin) {
        return fallback;
      }
      return incoming.toString();
    } catch {
      if (!raw.startsWith('/')) return fallback;
      return new URL(raw, frontend).toString();
    }
  }

  private calculateTokenExpiry() {
    const days = Number(
      this.configService.get<string>('INSTAGRAM_PAGE_TOKEN_TTL_DAYS') || 60,
    );
    const expiresAt = new Date();
    expiresAt.setUTCDate(expiresAt.getUTCDate() + (Number.isFinite(days) ? days : 60));
    return expiresAt;
  }

  private hasOAuthConfig() {
    return Boolean(
      this.configService.get<string>('META_APP_ID')?.trim() &&
        this.configService.get<string>('META_APP_SECRET')?.trim(),
    );
  }

  private validateInstagramOAuthConfig(): InstagramOAuthConfig {
    const clientId = process.env.META_APP_ID?.trim();
    const clientSecret = process.env.META_APP_SECRET?.trim();
    const redirectUri = process.env.INSTAGRAM_REDIRECT_URI?.trim();
    const authorizeUrl =
      process.env.META_OAUTH_AUTHORIZE_URL?.trim() ||
      'https://www.instagram.com/oauth/authorize';
    const scope =
      process.env.INSTAGRAM_OAUTH_SCOPE?.trim() ||
      [
        'instagram_business_basic',
        'instagram_manage_comments',
        'instagram_business_manage_messages',
      ].join(',');
    const authorizeUrlHost = this.extractUrlHost(authorizeUrl);
    const metaAppIdExists = Boolean(clientId);
    const metaAppIdIsNumeric = Boolean(clientId && /^\d+$/.test(clientId));
    const metaAppSecretExists = Boolean(clientSecret);
    const redirectUriExists = Boolean(redirectUri);
    const scopes = scope.split(',').map((item) => item.trim()).filter(Boolean);
    const scopesExist = scopes.length > 0;
    const authorizeUrlIsInstagram =
      authorizeUrl.startsWith('https://www.instagram.com/') &&
      authorizeUrlHost === 'www.instagram.com';

    this.logger.log(
      JSON.stringify({
        event: 'instagram.oauth.config.validation',
        metaAppIdExists,
        metaAppIdIsNumeric,
        redirectUriExists,
        authorizeHost: authorizeUrlHost,
        scopesCount: scopes.length,
      }),
    );

    if (
      !metaAppIdExists ||
      !metaAppIdIsNumeric ||
      !metaAppSecretExists ||
      !redirectUriExists ||
      !scopesExist ||
      !authorizeUrlIsInstagram
    ) {
      throw new BadRequestException({
        code: 'instagram_oauth_config_invalid',
        message:
          'Configuracao OAuth do Instagram invalida. Corrija as variaveis do Render antes de conectar.',
        details: {
          metaAppIdExists,
          metaAppIdIsNumeric,
          metaAppSecretExists,
          redirectUriExists,
          authorizeHost: authorizeUrlHost,
          scopesCount: scopes.length,
          authorizeUrlIsInstagram,
        },
      });
    }

    return {
      clientId: clientId as string,
      clientSecret: clientSecret as string,
      redirectUri: redirectUri as string,
      authorizeUrl,
      authorizeUrlHost,
      scope,
    };
  }

  private readMetaAppIdForTokenExchange() {
    const value = process.env.META_APP_ID?.trim();
    if (!value || !/^\d+$/.test(value)) {
      throw new BadRequestException(
        'META_APP_ID invalido. Configure o ID numerico do App Meta no Render.',
      );
    }

    return value;
  }

  private extractUrlHost(value: string) {
    try {
      return new URL(value).host;
    } catch {
      return 'invalid_url';
    }
  }

  private redactOAuthState(authUrl: string) {
    const url = new URL(authUrl);
    if (url.searchParams.has('state')) {
      url.searchParams.set('state', 'REDACTED');
    }
    return url.toString();
  }

  private readRequiredConfig(key: string) {
    const value = this.configService.get<string>(key)?.trim();
    if (!value) {
      throw new BadRequestException(`${key} nao configurado`);
    }
    return value;
  }

  private readHeader(req: Request, name: string) {
    const value = req.headers[name.toLowerCase()];
    if (Array.isArray(value)) return value[0] || '';
    return typeof value === 'string' ? value : '';
  }

  private async logWebhookFailure(
    companyId: string | null,
    payload: unknown,
    message: string,
  ) {
    await this.prisma.webhookLog
      .create({
        data: {
          companyId: companyId || undefined,
          provider: IntegrationProvider.INSTAGRAM,
          status: 'FAILED',
          message,
        },
      })
      .catch(() => undefined);

    this.logger.warn(
      JSON.stringify({
        event: 'instagram.webhook.ignored',
        companyId,
        message,
        payloadPreview: JSON.stringify(payload).slice(0, 500),
      }),
    );
  }
}
