import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IntegrationProvider, Prisma } from '@prisma/client';
import { Request } from 'express';
import { PrismaService } from '../../prisma/prisma.service';
import { PlanEntitlementsService } from '../billing/plan-entitlements.service';
import { MercadoLivreApiService } from './mercado-livre-api.service';
import { MercadoLivreCryptoService } from './mercado-livre-crypto.service';
import { MercadoLivreOAuthState, MercadoLivreTokenResponse } from './mercado-livre.types';
import { asRecord, asString, toInputJson } from './mercado-livre-utils';

@Injectable()
export class MercadoLivreAuthService {
  private readonly logger = new Logger(MercadoLivreAuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly api: MercadoLivreApiService,
    private readonly cryptoService: MercadoLivreCryptoService,
    private readonly planEntitlements: PlanEntitlementsService,
  ) {}

  async beginOAuth(input: {
    userId: string;
    companyId: string;
    returnTo?: string;
    req: Request;
  }) {
    await this.assertCompanyAccess(input.userId, input.companyId);
    await this.planEntitlements.assertIntegrationAccessForCompany(
      input.companyId,
      IntegrationProvider.MERCADOLIVRE,
    );
    const clientId = this.getClientId();
    const redirectUri = this.getRedirectUri(input.req);
    const state = this.encodeState({
      companyId: input.companyId,
      userId: input.userId,
      returnTo: this.resolveReturnTo(input.returnTo),
      issuedAt: new Date().toISOString(),
    });

    return {
      provider: 'MERCADOLIVRE',
      authUrl: this.api.buildAuthorizationUrl({ clientId, redirectUri, state }),
      callbackUrl: redirectUri,
    };
  }

  async handleCallback(input: { code?: string; state?: string; error?: string; errorDescription?: string; req: Request }) {
    const state = this.decodeState(input.state);
    const redirectUrl = new URL(state.returnTo);

    if (input.error || !input.code) {
      redirectUrl.searchParams.set('integration_provider', 'mercadolivre');
      redirectUrl.searchParams.set('integration_status', 'error');
      redirectUrl.searchParams.set('integration_message', input.errorDescription || input.error || 'OAuth Mercado Livre cancelado.');
      return { redirectUrl: redirectUrl.toString(), connected: false };
    }

    await this.assertCompanyAccess(state.userId, state.companyId);
    await this.planEntitlements.assertIntegrationAccessForCompany(
      state.companyId,
      IntegrationProvider.MERCADOLIVRE,
    );
    const token = await this.api.exchangeCode({
      clientId: this.getClientId(),
      clientSecret: this.getClientSecret(),
      redirectUri: this.getRedirectUri(input.req),
      code: input.code,
    });
    await this.saveToken(state.companyId, state.userId, token);

    redirectUrl.searchParams.set('integration_provider', 'mercadolivre');
    redirectUrl.searchParams.set('integration_status', 'connected');
    redirectUrl.searchParams.set('integration_message', 'Mercado Livre conectado com sucesso.');
    return {
      redirectUrl: redirectUrl.toString(),
      connected: true,
      companyId: state.companyId,
      userId: state.userId,
    };
  }

  async getValidAccessToken(companyId: string) {
    const token = await this.prisma.mercadoLivreOAuthToken.findUnique({
      where: { companyId },
    });

    if (!token || token.status !== 'connected') {
      throw new BadRequestException('Mercado Livre nao conectado para esta empresa');
    }

    const renewAt = new Date(Date.now() + 5 * 60 * 1000);
    if (token.expiresAt > renewAt) {
      return {
        accessToken: this.cryptoService.decrypt(token.accessTokenEncrypted),
        mlUserId: token.mlUserId,
      };
    }

    const refreshed = await this.api.refreshToken({
      clientId: this.getClientId(),
      clientSecret: this.getClientSecret(),
      refreshToken: this.cryptoService.decrypt(token.refreshTokenEncrypted),
    });
    await this.saveToken(token.companyId, token.userId || undefined, refreshed);
    return {
      accessToken: refreshed.access_token,
      mlUserId: String(refreshed.user_id),
    };
  }

  async getStatus(companyId: string) {
    const [token, lastWebhook] = await Promise.all([
      this.prisma.mercadoLivreOAuthToken.findUnique({
        where: { companyId },
        select: {
          mlUserId: true,
          nickname: true,
          status: true,
          expiresAt: true,
          lastSyncAt: true,
          updatedAt: true,
        },
      }),
      this.prisma.webhookLog.findFirst({
        where: { companyId, provider: IntegrationProvider.MERCADOLIVRE },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true, status: true },
      }),
    ]);

    return {
      connected: Boolean(token && token.status === 'connected'),
      mlUserId: token?.mlUserId || null,
      nickname: token?.nickname || null,
      status: token?.status || 'disconnected',
      expiresAt: token?.expiresAt?.toISOString() || null,
      lastSyncAt: token?.lastSyncAt?.toISOString() || null,
      updatedAt: token?.updatedAt?.toISOString() || null,
      webhook: lastWebhook
        ? {
            status: lastWebhook.status,
            lastEventAt: lastWebhook.createdAt.toISOString(),
          }
        : null,
    };
  }

  async disconnect(companyId: string) {
    await Promise.all([
      this.prisma.mercadoLivreOAuthToken.updateMany({
        where: { companyId },
        data: { status: 'disconnected' },
      }),
      this.prisma.integration.updateMany({
        where: { companyId, provider: IntegrationProvider.MERCADOLIVRE },
        data: { status: 'disconnected' },
      }),
      this.prisma.lGPDLog.create({
        data: {
          companyId,
          provider: IntegrationProvider.MERCADOLIVRE,
          action: 'mercado_livre.disconnect',
          metadata: { status: 'disconnected' },
        },
      }),
    ]);
    return { connected: false, status: 'disconnected' };
  }

  async findCompanyIdByMlUserId(mlUserId: string): Promise<string | null> {
    const token = await this.prisma.mercadoLivreOAuthToken.findFirst({
      where: { mlUserId, status: 'connected' },
      select: { companyId: true },
    });
    return token?.companyId || null;
  }

  private async saveToken(companyId: string, userId: string | undefined, token: MercadoLivreTokenResponse) {
    const mlUserId = String(token.user_id);
    const expiresAt = new Date(Date.now() + Number(token.expires_in || 21600) * 1000);
    const accessTokenEncrypted = this.cryptoService.encrypt(token.access_token);
    const refreshTokenEncrypted = this.cryptoService.encrypt(token.refresh_token);
    const nickname = await this.fetchNickname(token.access_token, mlUserId);

    await this.prisma.$transaction([
      this.prisma.mercadoLivreOAuthToken.upsert({
        where: { companyId },
        update: {
          userId: userId || undefined,
          mlUserId,
          nickname,
          accessTokenEncrypted,
          refreshTokenEncrypted,
          tokenType: token.token_type || 'bearer',
          scope: token.scope || null,
          expiresAt,
          status: 'connected',
          rawPayload: toInputJson({
            token_type: token.token_type,
            expires_in: token.expires_in,
            scope: token.scope,
            user_id: token.user_id,
          }),
        },
        create: {
          companyId,
          userId: userId || undefined,
          mlUserId,
          nickname,
          accessTokenEncrypted,
          refreshTokenEncrypted,
          tokenType: token.token_type || 'bearer',
          scope: token.scope || null,
          expiresAt,
          status: 'connected',
          rawPayload: toInputJson({
            token_type: token.token_type,
            expires_in: token.expires_in,
            scope: token.scope,
            user_id: token.user_id,
          }),
        },
      }),
      this.prisma.integration.upsert({
        where: {
          companyId_provider: {
            companyId,
            provider: IntegrationProvider.MERCADOLIVRE,
          },
        },
        update: {
          accessToken: accessTokenEncrypted,
          refreshToken: refreshTokenEncrypted,
          externalId: mlUserId,
          status: 'connected',
        },
        create: {
          companyId,
          provider: IntegrationProvider.MERCADOLIVRE,
          accessToken: accessTokenEncrypted,
          refreshToken: refreshTokenEncrypted,
          externalId: mlUserId,
          status: 'connected',
        },
      }),
      this.prisma.lGPDLog.create({
        data: {
          companyId,
          provider: IntegrationProvider.MERCADOLIVRE,
          actorType: 'SYSTEM',
          actorId: userId,
          action: 'mercado_livre.oauth.connected',
          subjectId: mlUserId,
          metadata: toInputJson({ scope: token.scope, expiresAt: expiresAt.toISOString() }),
        },
      }),
    ]);
    this.logger.log(
      JSON.stringify({
        event: 'mercado_livre.oauth.connected',
        companyId,
        userId: userId || null,
        mlUserId,
      }),
    );
  }

  private async fetchNickname(accessToken: string, mlUserId: string): Promise<string | null> {
    try {
      const user = await this.api.getResource<unknown>(accessToken, `/users/${mlUserId}`);
      return asString(asRecord(user)?.nickname);
    } catch {
      return null;
    }
  }

  private encodeState(payload: MercadoLivreOAuthState) {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${body}.${this.cryptoService.sign(body)}`;
  }

  private decodeState(raw: string | undefined): MercadoLivreOAuthState {
    if (!raw) throw new BadRequestException('state OAuth nao informado');
    const [body, signature] = raw.split('.');
    if (!body || !signature || !this.cryptoService.safeCompare(this.cryptoService.sign(body), signature)) {
      throw new BadRequestException('state OAuth invalido');
    }
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Partial<MercadoLivreOAuthState>;
    if (!parsed.companyId || !parsed.userId || !parsed.returnTo) {
      throw new BadRequestException('state OAuth incompleto');
    }
    return {
      companyId: parsed.companyId,
      userId: parsed.userId,
      returnTo: this.resolveReturnTo(parsed.returnTo),
      issuedAt: parsed.issuedAt || new Date().toISOString(),
    };
  }

  private async assertCompanyAccess(userId: string, companyId: string) {
    const company = await this.prisma.company.findFirst({
      where: {
        id: companyId,
        OR: [{ userId }, { users: { some: { id: userId } } }],
      },
      select: { id: true },
    });
    if (!company) throw new BadRequestException('Empresa invalida');
  }

  private getClientId(): string {
    return this.readRequiredEnv(['ML_CLIENT_ID', 'MERCADOLIVRE_OAUTH_CLIENT_ID']);
  }

  private getClientSecret(): string {
    return this.readRequiredEnv(['ML_CLIENT_SECRET', 'MERCADOLIVRE_OAUTH_CLIENT_SECRET']);
  }

  private getRedirectUri(req: Request): string {
    const configured = this.configService.get<string>('ML_REDIRECT_URI')?.trim();
    if (configured) return configured;

    const publicUrl =
      this.configService.get<string>('PUBLIC_API_URL')?.trim() ||
      this.configService.get<string>('APP_URL')?.trim() ||
      `${req.protocol}://${req.get('host') || 'localhost:3333'}`;
    const normalized = publicUrl.replace(/\/+$/, '');
    const apiBase = /\/api$/i.test(normalized) ? normalized : `${normalized}/api`;
    return `${apiBase}/auth/ml/callback`;
  }

  private resolveReturnTo(raw?: string): string {
    const frontend = this.configService.get<string>('FRONTEND_APP_URL')?.trim() || 'http://localhost:5173';
    const fallback = new URL('/integrations', frontend);
    if (!raw?.trim()) return fallback.toString();
    try {
      const incoming = new URL(raw);
      return incoming.origin === new URL(frontend).origin ? incoming.toString() : fallback.toString();
    } catch {
      return raw.startsWith('/') ? new URL(raw, frontend).toString() : fallback.toString();
    }
  }

  private readRequiredEnv(keys: string[]): string {
    const value = keys.map((key) => this.configService.get<string>(key)?.trim()).find(Boolean);
    if (!value) throw new BadRequestException(`Configure ${keys.join(' ou ')}`);
    return value;
  }
}
