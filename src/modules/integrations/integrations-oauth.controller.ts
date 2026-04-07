import {
  BadRequestException,
  Controller,
  Get,
  Logger,
  Param,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request, Response } from 'express';
import { Public } from '../../common/decorators/public.decorator';
import { ActiveCompanyGuard } from '../../common/guards/active-company.guard';

type OAuthProvider =
  | 'whatsapp'
  | 'instagram'
  | 'mercadolivre';

interface OAuthStatePayload {
  provider: OAuthProvider;
  companyId: string | null;
  userId: string | null;
  returnTo: string;
  issuedAt: string;
}

const OAUTH_ROUTE_PARAM =
  ':provider(whatsapp|instagram|mercadolivre)';

const PROVIDER_LABELS: Record<OAuthProvider, string> = {
  whatsapp: 'WhatsApp',
  instagram: 'Instagram',
  mercadolivre: 'Mercado Livre',
};

const PROVIDER_ENV_PREFIX: Record<OAuthProvider, string> = {
  whatsapp: 'WHATSAPP',
  instagram: 'INSTAGRAM',
  mercadolivre: 'MERCADOLIVRE',
};

const PROVIDER_SCOPES: Record<OAuthProvider, string> = {
  whatsapp: 'whatsapp_business_management whatsapp_business_messaging',
  instagram: 'instagram_basic instagram_manage_messages pages_manage_metadata',
  mercadolivre: 'offline_access read write',
};

@Controller('auth')
export class IntegrationsOAuthController {
  private readonly logger = new Logger(IntegrationsOAuthController.name);

  constructor(private readonly configService: ConfigService) {}

  @Get(OAUTH_ROUTE_PARAM)
  @UseGuards(ActiveCompanyGuard)
  async beginOAuth(
    @Param('provider') providerParam: string,
    @Query('companyId') companyId: string | undefined,
    @Query('returnTo') returnTo: string | undefined,
    @Req()
    req: Request & {
      user?: { id?: string; companyId?: string | null };
    },
  ) {
    const provider = this.parseProvider(providerParam);
    const callbackUrl = this.buildCallbackUrl(req, provider);
    const state = this.encodeState({
      provider,
      companyId: companyId?.trim() || req.user?.companyId?.trim() || null,
      userId: req.user?.id || null,
      returnTo: this.resolveReturnTo(returnTo),
      issuedAt: new Date().toISOString(),
    });
    const { authUrl, mode } = this.buildAuthorizeUrl(provider, callbackUrl, state);

    return {
      provider,
      mode,
      authUrl,
      callbackUrl,
    };
  }

  @Public()
  @Get(`${OAUTH_ROUTE_PARAM}/callback`)
  async handleCallback(
    @Param('provider') providerParam: string,
    @Query('state') stateRaw: string | undefined,
    @Query('code') code: string | undefined,
    @Query('access_token') accessToken: string | undefined,
    @Query('refresh_token') refreshToken: string | undefined,
    @Query('error') error: string | undefined,
    @Query('error_description') errorDescription: string | undefined,
    @Res() res: Response,
  ) {
    const provider = this.parseProvider(providerParam);
    const state = this.decodeState(stateRaw, provider);
    const success = !error && Boolean(code || accessToken);

    this.logger.log(
      JSON.stringify({
        event: 'integrations.oauth.callback',
        provider,
        success,
        companyId: state.companyId,
        userId: state.userId,
        hasCode: Boolean(code),
        hasAccessToken: Boolean(accessToken),
        hasRefreshToken: Boolean(refreshToken),
        receivedAt: new Date().toISOString(),
      }),
    );

    const redirectUrl = new URL(state.returnTo);
    redirectUrl.searchParams.set('integration_provider', provider);
    redirectUrl.searchParams.set(
      'integration_status',
      success ? 'connected' : 'error',
    );
    redirectUrl.searchParams.set(
      'integration_message',
      success
        ? `${PROVIDER_LABELS[provider]} conectado com sucesso.`
        : errorDescription ||
            error ||
            `Nao foi possivel concluir a conexao com ${PROVIDER_LABELS[provider]}.`,
    );

    return res.redirect(302, redirectUrl.toString());
  }

  private buildAuthorizeUrl(
    provider: OAuthProvider,
    callbackUrl: string,
    state: string,
  ): { authUrl: string; mode: 'oauth' | 'mock' } {
    const envPrefix = PROVIDER_ENV_PREFIX[provider];
    const authorizeUrl = this.configService
      .get<string>(`${envPrefix}_OAUTH_AUTHORIZE_URL`)
      ?.trim();
    const clientId = this.configService
      .get<string>(`${envPrefix}_OAUTH_CLIENT_ID`)
      ?.trim();
    const scope =
      this.configService.get<string>(`${envPrefix}_OAUTH_SCOPE`)?.trim() ||
      PROVIDER_SCOPES[provider];

    if (!authorizeUrl || !clientId) {
      return {
        authUrl: this.buildMockCallbackUrl(callbackUrl, state, provider),
        mode: 'mock',
      };
    }

    const url = new URL(authorizeUrl);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', callbackUrl);
    url.searchParams.set('state', state);
    if (scope) {
      url.searchParams.set('scope', scope);
    }

    return {
      authUrl: url.toString(),
      mode: 'oauth',
    };
  }

  private buildMockCallbackUrl(
    callbackUrl: string,
    state: string,
    provider: OAuthProvider,
  ) {
    const url = new URL(callbackUrl);
    url.searchParams.set('state', state);
    url.searchParams.set('code', `demo_code_${provider}`);
    url.searchParams.set('access_token', `demo_access_${provider}`);
    return url.toString();
  }

  private buildCallbackUrl(req: Request, provider: OAuthProvider) {
    const configuredBase =
      this.configService.get<string>('PUBLIC_API_URL')?.trim() ||
      this.configService.get<string>('APP_URL')?.trim();
    const origin = configuredBase || this.inferApiOrigin(req);
    const normalized = origin.replace(/\/+$/, '');
    const apiBase = /\/api$/i.test(normalized) ? normalized : `${normalized}/api`;
    return `${apiBase}/auth/${provider}/callback`;
  }

  private inferApiOrigin(req: Request) {
    const forwardedProto = this.readHeader(req, 'x-forwarded-proto');
    const forwardedHost = this.readHeader(req, 'x-forwarded-host');
    const protocol = forwardedProto || req.protocol || 'http';
    const host = forwardedHost || req.get('host') || 'localhost:3333';
    return `${protocol}://${host}`;
  }

  private resolveReturnTo(raw: string | undefined) {
    const configuredFrontend =
      this.configService.get<string>('FRONTEND_APP_URL')?.trim() ||
      'http://localhost:5173';
    const defaultUrl = new URL('/integrations', configuredFrontend);

    if (!raw?.trim()) {
      return defaultUrl.toString();
    }

    try {
      const incoming = new URL(raw);
      const allowedOrigin = new URL(configuredFrontend).origin;
      if (incoming.origin !== allowedOrigin) {
        return defaultUrl.toString();
      }
      return incoming.toString();
    } catch {
      if (!raw.startsWith('/')) {
        return defaultUrl.toString();
      }

      return new URL(raw, configuredFrontend).toString();
    }
  }

  private encodeState(payload: OAuthStatePayload) {
    return Buffer.from(JSON.stringify(payload)).toString('base64url');
  }

  private decodeState(
    raw: string | undefined,
    provider: OAuthProvider,
  ): OAuthStatePayload {
    if (!raw?.trim()) {
      throw new BadRequestException('state OAuth nao informado');
    }

    try {
      const decoded = Buffer.from(raw, 'base64url').toString('utf-8');
      const parsed = JSON.parse(decoded) as Partial<OAuthStatePayload>;
      return {
        provider,
        companyId:
          typeof parsed.companyId === 'string' && parsed.companyId.trim()
            ? parsed.companyId.trim()
            : null,
        userId:
          typeof parsed.userId === 'string' && parsed.userId.trim()
            ? parsed.userId.trim()
            : null,
        returnTo: this.resolveReturnTo(
          typeof parsed.returnTo === 'string' ? parsed.returnTo : undefined,
        ),
        issuedAt:
          typeof parsed.issuedAt === 'string'
            ? parsed.issuedAt
            : new Date().toISOString(),
      };
    } catch {
      throw new BadRequestException('state OAuth invalido');
    }
  }

  private parseProvider(raw: string): OAuthProvider {
    const normalized = raw.trim().toLowerCase();

    if (
      normalized !== 'whatsapp' &&
      normalized !== 'instagram' &&
      normalized !== 'mercadolivre'
    ) {
      throw new BadRequestException('Provedor OAuth invalido');
    }

    return normalized;
  }

  private readHeader(req: Request, name: string) {
    const value = req.headers[name];
    if (Array.isArray(value)) {
      return value[0] || '';
    }

    return typeof value === 'string' ? value : '';
  }
}
