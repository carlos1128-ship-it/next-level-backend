import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance, Method } from 'axios';
import {
  BillingWebhookEvent,
  CancelSubscriptionInput,
  CancelSubscriptionResult,
  ChangePlanInput,
  ChangePlanResult,
  CreateCheckoutInput,
  CreateCheckoutResult,
  PaymentProviderAdapter,
  VerifiedWebhookResult,
  VerifyWebhookInput,
} from '../payment-provider.adapter';
import { CaktoAuthService } from './cakto-auth.service';
import { CaktoOffer, CaktoOrder } from './cakto.types';
import { CaktoWebhookService } from './cakto-webhook.service';

@Injectable()
export class CaktoProvider implements PaymentProviderAdapter {
  readonly provider = 'CAKTO' as const;
  private readonly logger = new Logger(CaktoProvider.name);
  private readonly http: AxiosInstance;

  constructor(
    private readonly configService: ConfigService,
    private readonly authService: CaktoAuthService,
    private readonly webhookService: CaktoWebhookService,
  ) {
    this.http = axios.create({
      baseURL: this.baseUrl,
      timeout: Number(this.configService.get<string>('CAKTO_TIMEOUT_MS') || 20000),
    });
  }

  isCheckoutEnabled() {
    return this.checkoutUrlKeys.some((key) => Boolean(this.configService.get<string>(key)?.trim()));
  }

  async createCheckout(input: CreateCheckoutInput): Promise<CreateCheckoutResult> {
    if (!input.providerCheckoutUrl?.trim()) {
      throw new BadRequestException({
        code: 'PLAN_PRICE_UNAVAILABLE',
        message: 'Este plano esta indisponivel no momento.',
      });
    }

    const checkoutUrl = this.buildTrackedCheckoutUrl(input);
    this.logger.log(
      JSON.stringify({
        event: 'cakto.checkout.fixed_link.created',
        planKey: input.planKey,
        billingCycle: input.billingCycle,
        productId: input.providerProductId || null,
        offerId: input.providerOfferId || null,
        subscriptionId: input.subscriptionId,
      }),
    );

    return {
      checkoutUrl,
      provider: this.provider,
      providerCheckoutUrl: input.providerCheckoutUrl,
      providerProductId: input.providerProductId || null,
      providerOfferId: input.providerOfferId || null,
      providerRefId: input.externalId,
      providerSck: input.subscriptionId,
      providerMetadata: {
        ...(input.providerMetadata || {}),
        strategy: 'fixed_checkout_link',
      },
    };
  }

  async cancelSubscription(_input: CancelSubscriptionInput): Promise<CancelSubscriptionResult> {
    return {
      success: true,
      providerMetadata: {
        cancelStrategy: 'local_status_only',
        reason: 'Cakto subscription cancellation must be completed in Cakto panel/API when available.',
      },
    };
  }

  async changePlan(input: ChangePlanInput): Promise<ChangePlanResult> {
    return this.createCheckout(input);
  }

  async verifyWebhook(input: VerifyWebhookInput): Promise<VerifiedWebhookResult> {
    return this.webhookService.verify(input);
  }

  async mapWebhookEvent(input: unknown): Promise<BillingWebhookEvent> {
    return this.webhookService.map(input);
  }

  async getOffer(offerId: string) {
    return this.request<CaktoOffer>('GET', `/public_api/offers/${encodeURIComponent(offerId)}/`);
  }

  async listOffers(params?: Record<string, string | number | boolean>) {
    return this.request('GET', '/public_api/offers/', undefined, params);
  }

  async getOrder(orderId: string) {
    return this.request<CaktoOrder>('GET', `/public_api/orders/${encodeURIComponent(orderId)}/`);
  }

  async listOrders(params?: Record<string, string | number | boolean>) {
    return this.request('GET', '/public_api/orders/', undefined, params);
  }

  async refundOrder(orderId: string) {
    return this.request('POST', `/public_api/orders/${encodeURIComponent(orderId)}/refund/`);
  }

  async createWebhook(config: {
    name: string;
    url: string;
    products: string[];
    events: string[];
    status?: 'active' | 'inactive';
  }) {
    return this.request('POST', '/public_api/webhook/', {
      ...config,
      status: config.status || 'active',
    });
  }

  async validateConfiguredOffer(planKey: string, billingCycle: string, offerId?: string | null) {
    if (!offerId) return { valid: false, reason: 'missing_offer_id' };
    const offer = await this.getOffer(offerId);
    const isActive = offer.status === 'active';
    const isSubscription = offer.type === 'subscription';
    const expectedInterval = billingCycle === 'ANNUAL' ? 'year' : 'month';
    const intervalMatches =
      !offer.intervalType ||
      offer.intervalType === expectedInterval ||
      (billingCycle === 'ANNUAL' && offer.recurrence_period === 365) ||
      (billingCycle === 'MONTHLY' && offer.recurrence_period === 30);

    return {
      valid: Boolean(isActive && isSubscription && intervalMatches),
      planKey,
      billingCycle,
      offer,
    };
  }

  async request<T>(
    method: Method,
    path: string,
    body?: unknown,
    params?: Record<string, string | number | boolean>,
    retry = true,
  ): Promise<T> {
    try {
      const response = await this.http.request<T>({
        method,
        url: path,
        data: body,
        params,
        headers: await this.authService.getAuthHeaders(),
      });
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 401 && retry) {
        const response = await this.http.request<T>({
          method,
          url: path,
          data: body,
          params,
          headers: await this.authService.getAuthHeaders(true),
        });
        return response.data;
      }

      if (axios.isAxiosError(error)) {
        this.logger.warn(
          JSON.stringify({
            event: 'cakto.request_failed',
            method,
            path,
            status: error.response?.status || null,
          }),
        );
      }
      throw error;
    }
  }

  private buildTrackedCheckoutUrl(input: CreateCheckoutInput) {
    const rawUrl = input.providerCheckoutUrl || '';
    try {
      const url = new URL(rawUrl);
      url.searchParams.set('sck', input.subscriptionId);
      url.searchParams.set('utm_source', 'next_level');
      url.searchParams.set('utm_medium', 'billing');
      url.searchParams.set('utm_campaign', `${input.planKey}_${input.billingCycle}`);
      url.searchParams.set('success_url', `${this.frontendUrl}/billing/success`);
      url.searchParams.set('return_url', `${this.frontendUrl}/billing/success`);
      url.searchParams.set('cancel_url', `${this.frontendUrl}/billing/cancel`);
      if (input.userEmail) {
        url.searchParams.set('email', input.userEmail);
      }
      return url.toString();
    } catch {
      return rawUrl;
    }
  }

  private get checkoutUrlKeys() {
    return [
      'CAKTO_COMMON_MONTHLY_CHECKOUT_URL',
      'CAKTO_COMMON_ANNUAL_CHECKOUT_URL',
      'CAKTO_PREMIUM_MONTHLY_CHECKOUT_URL',
      'CAKTO_PREMIUM_ANNUAL_CHECKOUT_URL',
      'CAKTO_PRO_BUSINESS_MONTHLY_CHECKOUT_URL',
      'CAKTO_PRO_BUSINESS_ANNUAL_CHECKOUT_URL',
    ];
  }

  private get baseUrl() {
    return (
      this.configService.get<string>('CAKTO_API_BASE_URL') ||
      'https://api.cakto.com.br'
    ).replace(/\/+$/, '');
  }

  private get frontendUrl() {
    return (
      this.configService.get<string>('FRONTEND_URL') ||
      this.configService.get<string>('FRONTEND_APP_URL') ||
      'http://localhost:5173'
    ).replace(/\/+$/, '');
  }
}
