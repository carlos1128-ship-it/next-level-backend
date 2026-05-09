import {
  BadGatewayException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance, Method } from 'axios';
import {
  AbacatePayEnvelope,
  AbacatePaySubscriptionCheckout,
  CreateAbacatePaySubscriptionParams,
} from './types/abacatepay.types';

@Injectable()
export class AbacatePayService {
  private readonly logger = new Logger(AbacatePayService.name);
  private readonly http: AxiosInstance;

  constructor(private readonly configService: ConfigService) {
    this.http = axios.create({
      baseURL:
        this.configService.get<string>('ABACATEPAY_API_BASE_URL') ||
        'https://api.abacatepay.com/v2',
      timeout: Number(this.configService.get<string>('ABACATEPAY_TIMEOUT_MS') || 20000),
    });
  }

  async createSubscriptionCheckout(params: CreateAbacatePaySubscriptionParams) {
    return this.request<AbacatePaySubscriptionCheckout>('POST', '/subscriptions/create', {
      items: [{ id: params.productId, quantity: 1 }],
      methods: params.methods,
      customerId: params.customerId || undefined,
      externalId: params.externalId,
      returnUrl: params.returnUrl,
      completionUrl: params.completionUrl,
      metadata: params.metadata,
    });
  }

  async cancelSubscription(subscriptionId: string) {
    return this.request('POST', '/subscriptions/cancel', { id: subscriptionId });
  }

  async changeSubscriptionPlan(params: {
    subscriptionId: string;
    productId: string;
    externalId?: string;
    metadata?: Record<string, unknown>;
  }) {
    return this.request('POST', '/subscriptions/change-plan', params);
  }

  async createWebhook(input: { url: string; events: string[] }) {
    return this.request('POST', '/webhooks/create', input);
  }

  private async request<T>(method: Method, path: string, body?: unknown): Promise<T> {
    const apiKey = this.configService.get<string>('ABACATEPAY_API_KEY');
    if (!apiKey?.trim()) {
      throw new InternalServerErrorException({
        code: 'ABACATEPAY_NOT_CONFIGURED',
        message: 'Gateway de pagamento indisponivel no momento.',
      });
    }

    try {
      const response = await this.http.request<AbacatePayEnvelope<T> | T>({
        method,
        url: path,
        data: body,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
      });

      const payload = response.data as AbacatePayEnvelope<T>;
      if (
        payload &&
        typeof payload === 'object' &&
        'success' in payload &&
        payload.success === false
      ) {
        throw new BadGatewayException({
          code: 'ABACATEPAY_REQUEST_FAILED',
          message: 'A AbacatePay recusou a solicitacao.',
        });
      }

      return ((payload && typeof payload === 'object' && 'data' in payload
        ? payload.data
        : payload) || {}) as T;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        this.logger.warn(
          JSON.stringify({
            event: 'abacatepay.request_failed',
            method,
            path,
            status: error.response?.status || null,
          }),
        );
      }
      throw error instanceof BadGatewayException
        ? error
        : new BadGatewayException({
            code: 'ABACATEPAY_REQUEST_FAILED',
            message: 'Nao foi possivel iniciar o pagamento agora.',
          });
    }
  }
}
