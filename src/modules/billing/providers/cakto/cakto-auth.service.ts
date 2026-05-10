import { BadGatewayException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import { CaktoTokenResponse } from './cakto.types';

@Injectable()
export class CaktoAuthService {
  private readonly logger = new Logger(CaktoAuthService.name);
  private readonly http: AxiosInstance;
  private accessToken: string | null = null;
  private expiresAtMs = 0;
  private tokenPromise: Promise<string> | null = null;

  constructor(private readonly configService: ConfigService) {
    this.http = axios.create({
      baseURL: this.baseUrl,
      timeout: Number(this.configService.get<string>('CAKTO_TIMEOUT_MS') || 20000),
    });
  }

  async getAccessToken(forceRefresh = false) {
    if (!forceRefresh && this.accessToken && Date.now() < this.expiresAtMs) {
      return this.accessToken;
    }

    if (!this.tokenPromise) {
      this.tokenPromise = this.fetchToken().finally(() => {
        this.tokenPromise = null;
      });
    }

    return this.tokenPromise;
  }

  async getAuthHeaders(forceRefresh = false) {
    const token = await this.getAccessToken(forceRefresh);
    return {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };
  }

  private async fetchToken() {
    const clientId = this.configService.get<string>('CAKTO_CLIENT_ID');
    const clientSecret = this.configService.get<string>('CAKTO_CLIENT_SECRET');

    if (!clientId?.trim() || !clientSecret?.trim()) {
      throw new BadGatewayException({
        code: 'PAYMENT_PROVIDER_UNAVAILABLE',
        message: 'Gateway de pagamento temporariamente indisponivel.',
      });
    }

    try {
      const response = await this.http.post<CaktoTokenResponse>(
        '/public_api/token/',
        new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
        }).toString(),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        },
      );

      const token = response.data.access_token;
      if (!token) {
        throw new Error('Resposta sem access_token');
      }

      const expiresInMs = Math.max(Number(response.data.expires_in || 3600) - 120, 60) * 1000;
      this.accessToken = token;
      this.expiresAtMs = Date.now() + expiresInMs;
      this.logger.log(
        JSON.stringify({
          event: 'cakto.oauth.token_cached',
          expiresIn: response.data.expires_in,
          tokenType: response.data.token_type,
          scope: response.data.scope || null,
        }),
      );
      return token;
    } catch (error) {
      this.accessToken = null;
      this.expiresAtMs = 0;
      this.logger.warn(
        JSON.stringify({
          event: 'cakto.oauth.failed',
          message: this.extractMessage(error),
        }),
      );
      throw new BadGatewayException({
        code: 'PAYMENT_PROVIDER_UNAVAILABLE',
        message: 'Gateway de pagamento temporariamente indisponivel.',
      });
    }
  }

  private get baseUrl() {
    return (
      this.configService.get<string>('CAKTO_API_BASE_URL') ||
      'https://api.cakto.com.br'
    ).replace(/\/+$/, '');
  }

  private extractMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
}
