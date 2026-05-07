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
  tokenUrl: string;
  tokenUrlHost: string;
  rawScope: string;
  scope: string;
  scopes: string[];
  invalidScopesDetected: string[];
  extraAuthorizeParams: Record<string, string>;
};

type ParsedOAuthUrl = {
  url: URL;
  params: Record<string, string | string[]>;
  scopeNormalized: string;
};

@Injectable()
export class InstagramService {
  private readonly logger = new Logger(InstagramService.name);
  private readonly graphBaseUrl: string;
  private readonly graphVersion: string;
  private readonly instagramAuthorizeUrl =
    'https://www.instagram.com/oauth/authorize';
  private readonly instagramTokenUrl =
    'https://api.instagram.com/oauth/access_token';
  private readonly expectedInstagramClientId = '3641482999326328';
  private readonly expectedInstagramRedirectUri =
    'https://next-level-backend.onrender.com/api/instagram/callback';
  private readonly instagramBusinessScopes = [
    'instagram_business_basic',
    'instagram_business_manage_messages',
    'instagram_business_manage_comments',
  ];
  private readonly blockedInstagramScopes = [
    'pages_show_list',
    'pages_read_engagement',
    'pages_manage_metadata',
    'instagram_basic',
    'instagram_manage_messages',
    'instagram_manage_comments',
  ];

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
    this.logger.log(
      JSON.stringify({
        event: 'instagram.oauth.connect_started',
        companyId: input.companyId,
        authorizeHost: oauthConfig.authorizeUrlHost,
        redirectUriUsed: oauthConfig.redirectUri,
        scopesUsed: oauthConfig.scopes,
        invalidScopesDetected: oauthConfig.invalidScopesDetected,
        callbackReached: false,
      }),
    );
    const state = this.signState({
      companyId: input.companyId,
      userId: input.userId || null,
      returnTo: this.resolveReturnTo(input.returnTo),
      issuedAt: new Date().toISOString(),
    }, oauthConfig.clientSecret);

    const authUrl = this.buildOAuthAuthorizeUrl(oauthConfig.authorizeUrl, {
      ...oauthConfig.extraAuthorizeParams,
      client_id: oauthConfig.clientId,
      redirect_uri: oauthConfig.redirectUri,
      scope: oauthConfig.scope,
      response_type: 'code',
      state,
    });
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

  getOAuthDebugInfo() {
    const oauthConfig = this.validateInstagramOAuthConfig();
    const snapshot = this.buildOAuthDebugSnapshot(oauthConfig);

    return {
      generatedAuthorizeUrl: snapshot.generatedAuthorizeUrl,
      authorizeHost: oauthConfig.authorizeUrlHost,
      authorizePath: snapshot.parsed.url.pathname,
      queryParams: snapshot.safeQueryParams,
      redirectUriUsed: oauthConfig.redirectUri,
      rawScopeUsed: oauthConfig.rawScope,
      normalizedScopeUsed: oauthConfig.scope,
      scopesUsed: oauthConfig.scopes,
      invalidScopesDetected: oauthConfig.invalidScopesDetected,
      encodedScopePreview: encodeURIComponent(oauthConfig.scope),
      responseType: snapshot.safeQueryParams.response_type || null,
      envSummary: {
        metaAppIdExists: Boolean(oauthConfig.clientId),
        metaAppIdIsNumeric: /^\d+$/.test(oauthConfig.clientId),
        instagramRedirectUriExists: Boolean(oauthConfig.redirectUri),
        instagramOauthScopeExists: Boolean(oauthConfig.rawScope),
        instagramOauthAuthorizeUrl: oauthConfig.authorizeUrl,
        instagramOauthTokenUrl: oauthConfig.tokenUrl,
      },
    };
  }

  compareOAuthUrl(metaEmbeddedUrl: string | undefined, authorization?: string) {
    this.assertDebugCompareAllowed(authorization);

    if (!metaEmbeddedUrl?.trim()) {
      throw new BadRequestException('metaEmbeddedUrl nao informado');
    }

    const oauthConfig = this.validateInstagramOAuthConfig();
    const ourSnapshot = this.buildOAuthDebugSnapshot(oauthConfig);
    const our = ourSnapshot.parsed;
    const meta = this.parseOAuthUrl(metaEmbeddedUrl.trim());
    const expectedParams = ['client_id', 'redirect_uri', 'scope', 'response_type', 'state'];
    const ourKeys = this.paramKeys(our.params);
    const metaKeys = this.paramKeys(meta.params);
    const sameHost = our.url.host === meta.url.host;
    const samePath = our.url.pathname === meta.url.pathname;
    const sameClientId = this.firstParam(our.params.client_id) === this.firstParam(meta.params.client_id);
    const sameRedirectUri = this.firstParam(our.params.redirect_uri) === this.firstParam(meta.params.redirect_uri);
    const sameScope = our.scopeNormalized === meta.scopeNormalized;
    const missingParamsFromOurUrl = expectedParams.filter((key) => !ourKeys.includes(key));
    const extraParamsInOurUrl = ourKeys.filter((key) => !expectedParams.includes(key));
    const missingParamsFromMetaUrl = expectedParams.filter((key) => !metaKeys.includes(key));
    const extraParamsInMetaUrl = metaKeys.filter((key) => !expectedParams.includes(key));

    return {
      generatedAuthorizeUrl: ourSnapshot.generatedAuthorizeUrl,
      metaEmbeddedUrl: this.redactOAuthState(meta.url.toString()),
      comparison: {
        sameHost,
        samePath,
        sameClientId,
        sameRedirectUri,
        sameScope,
        missingParamsFromOurUrl,
        extraParamsInOurUrl,
        missingParamsFromMetaUrl,
        extraParamsInMetaUrl,
      },
      ourUrl: {
        host: our.url.host,
        path: our.url.pathname,
        queryParams: this.redactQueryParams(our.params),
      },
      metaUrl: {
        host: meta.url.host,
        path: meta.url.pathname,
        queryParams: this.redactQueryParams(meta.params),
      },
      possibleCause: this.diagnoseOAuthDifference({
        sameHost,
        samePath,
        sameClientId,
        sameRedirectUri,
        sameScope,
        extraParamsInMetaUrl,
        missingParamsFromMetaUrl,
      }),
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
    const oauthConfig = this.validateInstagramOAuthConfig();
    const existingAccount = await this.prisma.integrationAccount.findUnique({
      where: {
        companyId_provider: {
          companyId: state.companyId,
          provider: IntegrationProvider.INSTAGRAM,
        },
      },
      select: {
        instagramAccountId: true,
        igBusinessId: true,
        pageId: true,
        metadata: true,
      },
    });
    const existingMetadata = this.readObjectMetadata(existingAccount?.metadata);
    const preservedWebhookRecipientId =
      this.readKnownId(existingMetadata.webhookRecipientId) ||
      this.readKnownId(existingMetadata.recipientId) ||
      this.readKnownId(existingMetadata.instagramAccountId) ||
      (existingAccount?.instagramAccountId &&
      existingAccount.instagramAccountId !== account.igBusinessId
        ? existingAccount.instagramAccountId
        : null);
    const instagramAccountId = preservedWebhookRecipientId || account.igBusinessId;
    const allKnownInstagramIds = this.mergeKnownIds([
      existingAccount?.instagramAccountId,
      existingAccount?.igBusinessId,
      existingAccount?.pageId,
      existingMetadata.allKnownInstagramIds,
      preservedWebhookRecipientId,
      account.igBusinessId,
      account.pageId,
    ]);
    const accountMetadata = {
      ...existingMetadata,
      scopes: oauthConfig.scopes,
      recipientId: instagramAccountId,
      instagramAccountId,
      webhookRecipientId: preservedWebhookRecipientId || instagramAccountId,
      igBusinessId: account.igBusinessId,
      igUserId: account.igBusinessId,
      id: account.igBusinessId,
      pageId: account.pageId,
      allKnownInstagramIds,
    };

    await this.prisma.$transaction([
      this.prisma.integrationAccount.upsert({
        where: {
          companyId_provider: {
            companyId: state.companyId,
            provider: IntegrationProvider.INSTAGRAM,
          },
        },
        update: {
          instagramAccountId,
          igBusinessId: account.igBusinessId,
          igUsername: account.igUsername,
          pageId: account.pageId,
          pageName: account.pageName,
          pageAccessToken: encryptedPageToken,
          tokenExpiry,
          status: 'connected',
          metadata: accountMetadata,
        },
        create: {
          companyId: state.companyId,
          provider: IntegrationProvider.INSTAGRAM,
          instagramAccountId,
          igBusinessId: account.igBusinessId,
          igUsername: account.igUsername,
          pageId: account.pageId,
          pageName: account.pageName,
          pageAccessToken: encryptedPageToken,
          tokenExpiry,
          status: 'connected',
          metadata: accountMetadata,
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
          externalId: instagramAccountId,
          status: 'connected',
        },
        create: {
          companyId: state.companyId,
          provider: IntegrationProvider.INSTAGRAM,
          accessToken: encryptedPageToken,
          externalId: instagramAccountId,
          status: 'connected',
        },
      }),
      this.prisma.company.update({
        where: { id: state.companyId },
        data: { instagramAccountId },
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
        instagramAccountId,
        subscribed: subscription.success,
        instagramLogin: !account.pageId,
      }),
    );

    return {
      companyId: state.companyId,
      returnTo: state.returnTo,
      connected: true,
      igBusinessId: account.igBusinessId,
      instagramAccountId,
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
        instagramAccountId: true,
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
    const reconnectRequired = ['token_expired', 'reconnect_required'].includes(
      account.status,
    );

    return {
      connected: !expired && !reconnectRequired,
      status: expired ? 'token_expired' : account.status,
      provider_setup_required: !this.hasOAuthConfig(),
      provider: 'instagram',
      instagramAccountId: account.instagramAccountId || account.igBusinessId,
      igBusinessId: account.igBusinessId,
      igUsername: account.igUsername,
      pageId: account.pageId,
      pageName: account.pageName,
      tokenExpiry: account.tokenExpiry,
      tokenExpiresAt: account.tokenExpiry,
      tokenExpired: expired || reconnectRequired,
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
    const oauthConfig = this.validateInstagramOAuthConfig();
    const body = new URLSearchParams({
      client_id: oauthConfig.clientId,
      client_secret: oauthConfig.clientSecret,
      grant_type: 'authorization_code',
      redirect_uri: oauthConfig.redirectUri,
      code,
    });

    let data: InstagramOAuthTokenResponse;

    try {
      const response = await axios.post<InstagramOAuthTokenResponse>(
        oauthConfig.tokenUrl,
        body,
        {
          timeout: 10000,
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        },
      );
      data = response.data;
    } catch (error) {
      this.logger.warn(
        JSON.stringify({
          event: 'instagram.oauth.token_exchange_failed',
          tokenHost: oauthConfig.tokenUrlHost,
          redirectUriUsed: oauthConfig.redirectUri,
          scopesUsed: oauthConfig.scopes,
          message: this.extractSafeHttpErrorMessage(error),
        }),
      );
      throw new BadRequestException(
        'Instagram recusou a troca do codigo OAuth. Verifique redirect URI, app e permissoes no painel Meta.',
      );
    }

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

  private readObjectMetadata(value: unknown) {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }

  private readKnownId(value: unknown) {
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    if (typeof value === 'string' && value.trim()) return value.trim();
    return null;
  }

  private mergeKnownIds(values: unknown[]) {
    return values.reduce<string[]>((acc, value) => {
      const incoming = Array.isArray(value) ? value : [value];
      incoming.forEach((item) => {
        const id = this.readKnownId(item);
        if (id && !acc.includes(id)) acc.push(id);
      });
      return acc;
    }, []);
  }

  private hasOAuthConfig() {
    return Boolean(
      (
        this.configService.get<string>('INSTAGRAM_CLIENT_ID')?.trim() ||
        this.configService.get<string>('META_APP_ID')?.trim() ||
        this.expectedInstagramClientId
      ) &&
        this.configService.get<string>('META_APP_SECRET')?.trim() &&
        (
          this.configService.get<string>('INSTAGRAM_REDIRECT_URI')?.trim() ||
          this.expectedInstagramRedirectUri
        ),
    );
  }

  private validateInstagramOAuthConfig(): InstagramOAuthConfig {
    const clientId =
      process.env.INSTAGRAM_CLIENT_ID?.trim() ||
      process.env.META_APP_ID?.trim() ||
      this.expectedInstagramClientId;
    const clientSecret = process.env.META_APP_SECRET?.trim();
    const redirectUri =
      process.env.INSTAGRAM_REDIRECT_URI?.trim() ||
      this.expectedInstagramRedirectUri;
    const rawScope = process.env.INSTAGRAM_OAUTH_SCOPE?.trim();
    const authorizeUrl =
      process.env.INSTAGRAM_OAUTH_AUTHORIZE_URL?.trim() ||
      process.env.META_OAUTH_AUTHORIZE_URL?.trim() ||
      this.instagramAuthorizeUrl;
    const tokenUrl =
      process.env.INSTAGRAM_OAUTH_TOKEN_URL?.trim() ||
      this.instagramTokenUrl;
    const extraAuthorizeParams = this.readInstagramAuthorizeExtraParams();
    const scopeResult = this.normalizeInstagramOAuthScopes(rawScope || '');
    const scope = scopeResult.scope;
    const authorizeUrlHost = this.extractUrlHost(authorizeUrl);
    const tokenUrlHost = this.extractUrlHost(tokenUrl);
    const metaAppIdExists = Boolean(clientId);
    const metaAppIdIsNumeric = Boolean(clientId && /^\d+$/.test(clientId));
    const metaAppIdMatchesExpected = clientId === this.expectedInstagramClientId;
    const metaAppSecretExists = Boolean(clientSecret);
    const redirectUriExists = Boolean(redirectUri);
    const redirectUriMatchesExpected =
      redirectUri === this.expectedInstagramRedirectUri ||
      process.env.NODE_ENV !== 'production';
    const scopesEnvExists = Boolean(rawScope);
    const scopes = scopeResult.scopes;
    const scopesExist = scopes.length > 0;
    const authorizeUrlIsInstagram =
      authorizeUrl.startsWith(this.instagramAuthorizeUrl) &&
      authorizeUrlHost === 'www.instagram.com';
    const tokenUrlIsInstagram =
      tokenUrl.startsWith(this.instagramTokenUrl) &&
      tokenUrlHost === 'api.instagram.com';

    this.logger.log(
      JSON.stringify({
        event: 'instagram.oauth.config.validation',
        metaAppIdExists,
        metaAppIdIsNumeric,
        metaAppIdMatchesExpected,
        redirectUriExists,
        redirectUriUsed: redirectUri || null,
        redirectUriMatchesExpected,
        authorizeHost: authorizeUrlHost,
        tokenUrlHost,
        scopesEnvExists,
        scopesUsed: scopes,
        invalidScopesDetected: scopeResult.invalidScopesDetected,
      }),
    );

    if (
      !metaAppIdExists ||
      !metaAppIdIsNumeric ||
      !metaAppIdMatchesExpected ||
      !metaAppSecretExists ||
      !redirectUriExists ||
      !redirectUriMatchesExpected ||
      !scopesExist ||
      !authorizeUrlIsInstagram ||
      !tokenUrlIsInstagram
    ) {
      throw new BadRequestException({
        code: 'instagram_oauth_config_invalid',
        message:
          'Configuracao OAuth do Instagram invalida. Corrija as variaveis do Render antes de conectar.',
        details: {
          metaAppIdExists,
          metaAppIdIsNumeric,
          metaAppIdMatchesExpected,
          metaAppSecretExists,
          redirectUriExists,
          redirectUriMatchesExpected,
          scopesEnvExists,
          authorizeHost: authorizeUrlHost,
          tokenUrlHost,
          scopesUsed: scopes,
          invalidScopesDetected: scopeResult.invalidScopesDetected,
          authorizeUrlIsInstagram,
          tokenUrlIsInstagram,
        },
      });
    }

    return {
      clientId: clientId as string,
      clientSecret: clientSecret as string,
      redirectUri: redirectUri as string,
      authorizeUrl,
      authorizeUrlHost,
      tokenUrl,
      tokenUrlHost,
      rawScope: rawScope || '',
      scope,
      scopes,
      invalidScopesDetected: scopeResult.invalidScopesDetected,
      extraAuthorizeParams,
    };
  }

  private normalizeInstagramOAuthScopes(value: string) {
    const incoming = value
      .split(/[\s,]+/)
      .map((item) => item.trim())
      .filter(Boolean);
    const invalidScopesDetected = incoming.filter((scope) =>
      this.blockedInstagramScopes.includes(scope),
    );
    const scopes = [
      ...incoming.filter(
        (scope) =>
          this.instagramBusinessScopes.includes(scope) &&
          !this.blockedInstagramScopes.includes(scope),
      ),
      ...this.instagramBusinessScopes,
    ].filter((scope, index, list) => list.indexOf(scope) === index);

    return {
      scopes,
      invalidScopesDetected: [
        ...new Set(invalidScopesDetected),
      ],
      scope: scopes.join(','),
    };
  }

  private readInstagramAuthorizeExtraParams() {
    const extra: Record<string, string> = {};
    const raw = process.env.INSTAGRAM_OAUTH_EXTRA_PARAMS?.trim();

    if (!raw) {
      extra.enable_fb_login = '0';
      extra.force_authentication = '1';
      return extra;
    }

    raw.split('&').forEach((pair) => {
      const [keyRaw, ...valueParts] = pair.split('=');
      const key = decodeURIComponent((keyRaw || '').trim());
      const value = decodeURIComponent(valueParts.join('=').trim());
      if (
        !key ||
        [
          'client_id',
          'redirect_uri',
          'scope',
          'response_type',
          'state',
          'force_reauth',
        ].includes(key)
      ) {
        return;
      }
      extra[key] = value || 'true';
    });

    if (!extra.enable_fb_login) {
      extra.enable_fb_login = '0';
    }
    if (!extra.force_authentication) {
      extra.force_authentication = '1';
    }

    return extra;
  }

  private buildOAuthDebugSnapshot(oauthConfig: InstagramOAuthConfig) {
    const generatedUrlForParsing = this.buildOAuthAuthorizeUrl(oauthConfig.authorizeUrl, {
      ...oauthConfig.extraAuthorizeParams,
      client_id: oauthConfig.clientId,
      redirect_uri: oauthConfig.redirectUri,
      scope: oauthConfig.scope,
      response_type: 'code',
      state: 'STATE_PLACEHOLDER',
    });
    const parsed = this.parseOAuthUrl(generatedUrlForParsing);
    const generatedAuthorizeUrl = generatedUrlForParsing.replace(
      'state=STATE_PLACEHOLDER',
      'state=<STATE>',
    );

    return {
      generatedAuthorizeUrl,
      parsed,
      safeQueryParams: this.redactQueryParams(parsed.params),
    };
  }

  private parseOAuthUrl(value: string): ParsedOAuthUrl {
    try {
      const url = new URL(value);
      const params: Record<string, string | string[]> = {};
      url.searchParams.forEach((paramValue, key) => {
        const current = params[key];
        if (Array.isArray(current)) {
          current.push(paramValue);
        } else if (current !== undefined) {
          params[key] = [current, paramValue];
        } else {
          params[key] = paramValue;
        }
      });

      return {
        url,
        params,
        scopeNormalized: this.normalizeOAuthScopeForComparison(
          this.firstParam(params.scope) || '',
        ),
      };
    } catch {
      throw new BadRequestException('URL OAuth invalida');
    }
  }

  private normalizeOAuthScopeForComparison(value: string) {
    return value
      .split(/[\s,]+/)
      .map((item) => item.trim())
      .filter(Boolean)
      .join(',');
  }

  private redactQueryParams(params: Record<string, string | string[]>) {
    const redacted: Record<string, string | string[]> = {};
    Object.entries(params).forEach(([key, value]) => {
      redacted[key] = key === 'state' ? '<STATE>' : value;
    });
    return redacted;
  }

  private assertDebugCompareAllowed(authorization?: string) {
    if (process.env.NODE_ENV !== 'production') return;

    const expected = process.env.INTERNAL_AUTOMATION_TOKEN?.trim();
    if (!expected) {
      throw new UnauthorizedException('INTERNAL_AUTOMATION_TOKEN nao configurado');
    }

    const provided = authorization?.replace(/^Bearer\s+/i, '').trim();
    if (!provided || !this.timingSafeEqual(provided, expected)) {
      throw new UnauthorizedException('Token interno invalido');
    }
  }

  private diagnoseOAuthDifference(input: {
    sameHost: boolean;
    samePath: boolean;
    sameClientId: boolean;
    sameRedirectUri: boolean;
    sameScope: boolean;
    extraParamsInMetaUrl: string[];
    missingParamsFromMetaUrl: string[];
  }) {
    if (!input.sameHost) {
      return 'Host diferente do link oficial Meta.';
    }
    if (!input.samePath) {
      return 'Path OAuth diferente do link oficial Meta.';
    }
    if (!input.sameClientId) {
      return 'client_id diferente. Confirme se META_APP_ID e Instagram App ID sao do mesmo app.';
    }
    if (!input.sameRedirectUri) {
      return 'redirect_uri diferente da URL oficial/configurada.';
    }
    if (!input.sameScope) {
      return 'Scopes diferentes. O link Meta inclui uma lista diferente de permissoes.';
    }

    const platformHints = [
      'force_reauth',
      'enable_fb_login',
      'platform_app_id',
      'business_login_config_id',
      'config_id',
      'logger_id',
      'next',
    ].filter((key) => input.extraParamsInMetaUrl.includes(key));

    if (platformHints.length) {
      return `Link Meta tem parametros adicionais: ${platformHints.join(', ')}.`;
    }
    if (input.missingParamsFromMetaUrl.length) {
      return `Link Meta nao tem parametros esperados: ${input.missingParamsFromMetaUrl.join(', ')}.`;
    }

    return 'URLs equivalentes nos campos essenciais. Se Invalid platform app persistir, a causa provavel e configuracao no painel Meta.';
  }

  private paramKeys(params: Record<string, string | string[]>) {
    return Object.keys(params).sort((left, right) => left.localeCompare(right));
  }

  private firstParam(value: string | string[] | undefined) {
    return Array.isArray(value) ? value[0] : value;
  }

  private buildOAuthAuthorizeUrl(baseUrl: string, params: Record<string, string>) {
    const separator = baseUrl.includes('?') ? '&' : '?';
    const query = Object.entries(params)
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
      .join('&');

    return `${baseUrl}${separator}${query}`;
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

  private extractSafeHttpErrorMessage(error: unknown) {
    if (axios.isAxiosError(error)) {
      const data = error.response?.data as
        | { error?: { message?: string; type?: string; code?: number } }
        | undefined;
      return {
        status: error.response?.status || null,
        metaCode: data?.error?.code || null,
        metaType: data?.error?.type || null,
        metaMessage: data?.error?.message || error.message,
      };
    }

    return {
      status: null,
      metaCode: null,
      metaType: null,
      metaMessage: error instanceof Error ? error.message : 'Erro desconhecido',
    };
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
