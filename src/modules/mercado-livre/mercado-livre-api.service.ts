import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosError, AxiosRequestConfig } from 'axios';
import { MercadoLivreProductItem, MercadoLivreTokenResponse, JsonRecord } from './mercado-livre.types';
import { asRecord, asRecordArray } from './mercado-livre-utils';

@Injectable()
export class MercadoLivreApiService {
  private readonly logger = new Logger(MercadoLivreApiService.name);

  constructor(private readonly configService: ConfigService) {}

  buildAuthorizationUrl(params: {
    clientId: string;
    redirectUri: string;
    state: string;
  }): string {
    const base =
      this.configService.get<string>('ML_AUTHORIZATION_URL')?.trim() ||
      this.configService.get<string>('MERCADOLIVRE_OAUTH_AUTHORIZE_URL')?.trim() ||
      'https://auth.mercadolivre.com.br/authorization';
    const url = new URL(base);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', params.clientId);
    url.searchParams.set('redirect_uri', params.redirectUri);
    url.searchParams.set('state', params.state);
    return url.toString();
  }

  async exchangeCode(input: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    code: string;
  }): Promise<MercadoLivreTokenResponse> {
    return this.postToken({
      grant_type: 'authorization_code',
      client_id: input.clientId,
      client_secret: input.clientSecret,
      code: input.code,
      redirect_uri: input.redirectUri,
    });
  }

  async refreshToken(input: {
    clientId: string;
    clientSecret: string;
    refreshToken: string;
  }): Promise<MercadoLivreTokenResponse> {
    return this.postToken({
      grant_type: 'refresh_token',
      client_id: input.clientId,
      client_secret: input.clientSecret,
      refresh_token: input.refreshToken,
    });
  }

  async getResource<T = JsonRecord>(
    accessToken: string,
    path: string,
    params?: Record<string, string | number | boolean | undefined>,
  ): Promise<T> {
    const url = this.buildApiUrl(path);
    try {
      const { data } = await axios.get<T>(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
        params,
        timeout: 20000,
      });
      return data;
    } catch (error) {
      throw this.toProviderError(error, `Falha Mercado Livre GET ${path}`);
    }
  }

  async postResource<T = JsonRecord>(
    accessToken: string,
    path: string,
    body: JsonRecord,
  ): Promise<T> {
    const url = this.buildApiUrl(path);
    try {
      const { data } = await axios.post<T>(url, body, {
        headers: { Authorization: `Bearer ${accessToken}` },
        timeout: 20000,
      });
      return data;
    } catch (error) {
      throw this.toProviderError(error, `Falha Mercado Livre POST ${path}`);
    }
  }

  async listSellerItemIds(accessToken: string, mlUserId: string): Promise<string[]> {
    const itemIds: string[] = [];
    const limit = 50;
    for (let offset = 0; offset < 500; offset += limit) {
      const data = await this.getResource<JsonRecord>(
        accessToken,
        `/users/${mlUserId}/items/search`,
        { limit, offset },
      );
      const results = Array.isArray(data.results) ? data.results : [];
      itemIds.push(...results.map((item) => String(item)).filter(Boolean));
      const paging = asRecord(data.paging);
      const total = Number(paging?.total ?? itemIds.length);
      if (itemIds.length >= total || results.length < limit) break;
    }
    return Array.from(new Set(itemIds));
  }

  async getItems(accessToken: string, itemIds: string[]): Promise<MercadoLivreProductItem[]> {
    const items: MercadoLivreProductItem[] = [];
    for (let index = 0; index < itemIds.length; index += 20) {
      const ids = itemIds.slice(index, index + 20).join(',');
      const response = await this.getResource<unknown>(accessToken, '/items', { ids });
      const rows = asRecordArray(response);
      rows.forEach((row) => {
        if (Number(row.code) !== 200) return;
        const body = asRecord(row.body);
        if (!body?.id || !body.title) return;
        items.push({
          id: String(body.id),
          title: String(body.title),
          price: Number(body.price ?? 0),
          base_price: body.base_price === null ? null : Number(body.base_price ?? body.price ?? 0),
          currency_id: body.currency_id ? String(body.currency_id) : null,
          available_quantity: body.available_quantity === null ? null : Number(body.available_quantity ?? 0),
          sold_quantity: body.sold_quantity === null ? null : Number(body.sold_quantity ?? 0),
          status: body.status ? String(body.status) : null,
          permalink: body.permalink ? String(body.permalink) : null,
          category_id: body.category_id ? String(body.category_id) : null,
          seller_custom_field: body.seller_custom_field ? String(body.seller_custom_field) : null,
        });
      });
    }
    return items;
  }

  private async postToken(params: Record<string, string>): Promise<MercadoLivreTokenResponse> {
    const url =
      this.configService.get<string>('ML_TOKEN_URL')?.trim() ||
      'https://api.mercadolibre.com/oauth/token';
    try {
      const { data } = await axios.post<MercadoLivreTokenResponse>(
        url,
        new URLSearchParams(params).toString(),
        {
          headers: {
            accept: 'application/json',
            'content-type': 'application/x-www-form-urlencoded',
          },
          timeout: 20000,
        },
      );
      return data;
    } catch (error) {
      throw this.toProviderError(error, 'Falha ao trocar token Mercado Livre');
    }
  }

  private buildApiUrl(path: string) {
    const base = this.configService.get<string>('ML_API_BASE_URL')?.trim() || 'https://api.mercadolibre.com';
    return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
  }

  private toProviderError(error: unknown, fallback: string): BadRequestException {
    if (axios.isAxiosError(error)) {
      const axiosError = error as AxiosError<JsonRecord>;
      const providerMessage =
        typeof axiosError.response?.data?.message === 'string'
          ? axiosError.response.data.message
          : typeof axiosError.response?.data?.error === 'string'
            ? axiosError.response.data.error
            : axiosError.message;
      this.logger.warn(`${fallback}: ${providerMessage}`);
      return new BadRequestException({
        code: 'mercado_livre_api_error',
        message: providerMessage || fallback,
        status: axiosError.response?.status,
      });
    }

    const message = error instanceof Error ? error.message : fallback;
    this.logger.warn(`${fallback}: ${message}`);
    return new BadRequestException({
      code: 'mercado_livre_api_error',
      message,
    });
  }
}
