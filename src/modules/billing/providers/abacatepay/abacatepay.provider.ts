import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SubscriptionStatus } from '@prisma/client';
import { createHmac, timingSafeEqual } from 'crypto';
import { Request } from 'express';
import { AbacatePayService } from '../../abacatepay.service';
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

@Injectable()
export class AbacatePayProvider implements PaymentProviderAdapter {
  readonly provider = 'ABACATEPAY' as const;

  constructor(
    private readonly abacatePayService: AbacatePayService,
    private readonly configService: ConfigService,
  ) {}

  isCheckoutEnabled() {
    return Boolean(this.configService.get<string>('ABACATEPAY_API_KEY')?.trim());
  }

  async createCheckout(input: CreateCheckoutInput): Promise<CreateCheckoutResult> {
    if (!input.legacyProductId) {
      throw new BadRequestException({
        code: 'PLAN_PRICE_UNAVAILABLE',
        message: 'Este plano esta indisponivel no momento.',
      });
    }

    const checkout = await this.abacatePayService.createSubscriptionCheckout({
      productId: input.legacyProductId,
      methods: this.subscriptionMethods(),
      externalId: input.externalId,
      returnUrl: `${this.frontendUrl}/planos`,
      completionUrl: `${this.frontendUrl}/billing/success`,
      metadata: {
        localSubscriptionId: input.subscriptionId,
        userId: input.userId,
        companyId: input.companyId,
        planKey: input.planKey,
        billingCycle: input.billingCycle,
      },
    });

    return {
      checkoutUrl: checkout.url,
      provider: this.provider,
      providerCheckoutId: checkout.id || null,
      providerCheckoutUrl: checkout.url || null,
      providerRefId: input.externalId,
      providerProductId: input.legacyProductId,
      providerMetadata: { abacatepayStatus: checkout.status || null },
    };
  }

  async cancelSubscription(input: CancelSubscriptionInput): Promise<CancelSubscriptionResult> {
    if (input.providerSubscriptionId) {
      await this.abacatePayService.cancelSubscription(input.providerSubscriptionId);
    }
    return { success: true };
  }

  async changePlan(input: ChangePlanInput): Promise<ChangePlanResult> {
    return this.createCheckout(input);
  }

  async verifyWebhook(input: VerifyWebhookInput): Promise<VerifiedWebhookResult> {
    const expected = this.configService.get<string>('ABACATEPAY_WEBHOOK_SECRET');
    if (!expected?.trim()) return { valid: false, provider: this.provider, reason: 'missing_secret' };

    const supplied =
      this.headerValue(input.headers, 'x-abacatepay-secret') ||
      this.headerValue(input.headers, 'x-webhook-secret') ||
      this.queryValue(input.query, 'webhookSecret') ||
      this.queryValue(input.query, 'secret');

    const hasSharedSecret = supplied ? this.safeCompare(supplied, expected) : false;
    const signature = this.headerValue(input.headers, 'x-webhook-signature');
    if (!signature) return { valid: hasSharedSecret, provider: this.provider };
    if (!input.rawBody) return { valid: hasSharedSecret, provider: this.provider };

    const hmacKey = this.configService.get<string>('ABACATEPAY_WEBHOOK_PUBLIC_KEY') || expected;
    const digestBase64 = createHmac('sha256', hmacKey).update(input.rawBody).digest('base64');
    const digestHex = createHmac('sha256', hmacKey).update(input.rawBody).digest('hex');

    return {
      valid:
        this.safeCompare(signature, digestBase64) ||
        this.safeCompare(signature, digestHex) ||
        hasSharedSecret,
      provider: this.provider,
    };
  }

  async mapWebhookEvent(input: unknown): Promise<BillingWebhookEvent> {
    const payload = this.asRecord(input);
    const data = this.extractData(payload);
    const metadata = this.asRecord(data.metadata);
    const rawEventType = this.extractString(payload, ['event', 'type', 'eventType', 'event_type']) || 'unknown';
    const eventType = this.normalizeAbacatePayEvent(rawEventType);
    const checkoutId =
      this.extractString(data, ['id', 'checkoutId', 'checkout_id', 'billingId']) ||
      this.extractString(payload, ['checkoutId', 'checkout_id']);
    const subscriptionId =
      this.extractString(data, ['subscriptionId', 'subscription_id']) ||
      this.extractString(payload, ['subscriptionId', 'subscription_id']);

    return {
      provider: this.provider,
      eventType,
      rawEventType,
      eventId: this.extractString(payload, ['id', 'eventId', 'event_id']),
      checkoutId,
      subscriptionId,
      customerId: this.extractString(data, ['customerId', 'customer_id']),
      refId:
        this.extractString(data, ['externalId', 'external_id']) ||
        this.extractString(metadata, ['externalId', 'external_id']),
      sck: this.extractString(metadata, ['localSubscriptionId', 'subscriptionId']),
      currentPeriodStart: this.extractDate(data, ['currentPeriodStart', 'current_period_start', 'periodStart']),
      currentPeriodEnd: this.extractDate(data, ['currentPeriodEnd', 'current_period_end', 'periodEnd']),
      paidAt: ['checkout.completed', 'subscription.completed', 'subscription.renewed'].includes(eventType)
        ? new Date()
        : null,
      canceledAt: eventType === 'subscription.cancelled' ? new Date() : null,
      targetStatus: this.mapStatus(eventType),
      shouldActivate: ['checkout.completed', 'subscription.completed', 'subscription.renewed'].includes(eventType),
      rawPayload: input,
    };
  }

  private mapStatus(eventType: string) {
    const map: Record<string, SubscriptionStatus> = {
      'checkout.completed': SubscriptionStatus.PAID,
      'subscription.completed': SubscriptionStatus.ACTIVE,
      'subscription.renewed': SubscriptionStatus.ACTIVE,
      'subscription.cancelled': SubscriptionStatus.CANCELLED,
      'checkout.refunded': SubscriptionStatus.REFUNDED,
      'checkout.disputed': SubscriptionStatus.DISPUTED,
      'checkout.lost': SubscriptionStatus.LOST,
      'subscription.payment_failed': SubscriptionStatus.FAILED,
      'subscription.trial_started': SubscriptionStatus.TRIAL,
    };
    return map[eventType] || null;
  }

  private normalizeAbacatePayEvent(eventType: string) {
    const eventMap: Record<string, string> = {
      'assinatura.concluida': 'subscription.completed',
      'assinatura.renovada': 'subscription.renewed',
      'assinatura.cancelada': 'subscription.cancelled',
      'assinatura.pagamento_falha': 'subscription.payment_failed',
      'checkout.concluido': 'checkout.completed',
      'checkout.reembolsado': 'checkout.refunded',
      'checkout.disputado': 'checkout.disputed',
      'checkout.perdido': 'checkout.lost',
    };
    return eventMap[eventType] || eventType;
  }

  private subscriptionMethods() {
    if (!this.isTrue(this.configService.get<string>('ABACATEPAY_ENABLE_PIX_SUBSCRIPTIONS'))) {
      return ['CARD'];
    }

    const raw = this.configService.get<string>('ABACATEPAY_SUBSCRIPTION_METHODS') || 'CARD';
    const parsed = this.parsePaymentMethods(raw);
    return parsed.length ? parsed : ['CARD'];
  }

  private parsePaymentMethods(raw: string) {
    const allowed = new Set(['PIX', 'CARD']);
    let values: unknown[] = [];
    const trimmed = raw.trim();

    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        values = Array.isArray(parsed) ? parsed : [parsed];
      } catch {
        values = [trimmed];
      }
    } else {
      values = trimmed.split(',');
    }

    return Array.from(
      new Set(
        values
          .flatMap((value) => String(value || '').split(','))
          .map((value) => value.trim().toUpperCase())
          .filter((value) => allowed.has(value)),
      ),
    );
  }

  private get frontendUrl() {
    return (
      this.configService.get<string>('FRONTEND_URL') ||
      this.configService.get<string>('FRONTEND_APP_URL') ||
      'http://localhost:5173'
    ).replace(/\/+$/, '');
  }

  private isTrue(value: unknown) {
    return String(value || '').trim().toLowerCase() === 'true';
  }

  private extractData(payload: Record<string, unknown>) {
    const data = payload.data || payload.object || payload.payload;
    return data && typeof data === 'object' ? (data as Record<string, unknown>) : payload;
  }

  private extractString(source: Record<string, unknown>, keys: string[]) {
    for (const key of keys) {
      const value = source[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
      if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    }
    return null;
  }

  private extractDate(source: Record<string, unknown>, keys: string[]) {
    const raw = this.extractString(source, keys);
    if (!raw) return null;
    const date = new Date(raw);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  private headerValue(headers: Record<string, unknown>, key: string) {
    const value = headers[key] || headers[key.toLowerCase()];
    return Array.isArray(value) ? String(value[0]) : value ? String(value) : null;
  }

  private queryValue(query: Record<string, unknown> | undefined, key: string) {
    const value = query?.[key];
    return Array.isArray(value) ? String(value[0]) : value ? String(value) : null;
  }

  private safeCompare(a: string, b: string) {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    if (left.length !== right.length) return false;
    return timingSafeEqual(left, right);
  }

  private asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  }
}
