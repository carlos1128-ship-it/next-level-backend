import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SubscriptionStatus } from '@prisma/client';
import { timingSafeEqual } from 'crypto';
import {
  BillingWebhookEvent,
  VerifiedWebhookResult,
  VerifyWebhookInput,
} from '../payment-provider.adapter';

const EVENT_ALIASES: Record<string, string> = {
  compra_aprovada: 'purchase_approved',
  compra_recusada: 'purchase_refused',
  reembolso: 'refund',
  assinatura_criada: 'subscription_created',
  assinatura_cancelada: 'subscription_canceled',
  assinatura_renovada: 'subscription_renewed',
  renovacao_assinatura_recusada: 'subscription_renewal_refused',
  abandono_checkout: 'checkout_abandonment',
};

@Injectable()
export class CaktoWebhookService {
  constructor(private readonly configService: ConfigService) {}

  verify(input: VerifyWebhookInput): VerifiedWebhookResult {
    const expected = this.configService.get<string>('CAKTO_WEBHOOK_SECRET');
    if (!expected?.trim()) {
      return {
        valid: !this.isProduction,
        provider: 'CAKTO',
        reason: this.isProduction ? 'missing_secret' : 'dev_secret_not_configured',
      };
    }

    const body = this.asRecord(input.body);
    const fields = this.asRecord(body.fields);
    const supplied =
      this.headerValue(input.headers, 'x-cakto-secret') ||
      this.headerValue(input.headers, 'x-webhook-secret') ||
      this.authorizationSecret(this.headerValue(input.headers, 'authorization')) ||
      this.extractString(body, ['secret', 'token']) ||
      this.extractString(fields, ['secret', 'token']);

    return {
      valid: supplied ? this.safeCompare(supplied, expected) : false,
      provider: 'CAKTO',
      reason: supplied ? undefined : 'missing_supplied_secret',
    };
  }

  map(input: unknown): BillingWebhookEvent {
    const payload = this.asRecord(input);
    const data = this.extractData(payload);
    const customer = this.extractCustomer(payload, data);
    const product = this.extractProduct(payload, data);
    const rawEventType =
      this.extractString(payload, ['event', 'eventType', 'event_type', 'type', 'custom_id', 'name']) ||
      this.extractString(data, ['event', 'eventType', 'event_type', 'type', 'custom_id', 'name']) ||
      'unknown';
    const eventType = this.normalizeEvent(rawEventType);
    const targetStatus = this.mapStatus(eventType);

    return {
      provider: 'CAKTO',
      eventType,
      rawEventType,
      eventId: this.extractString(payload, ['id', 'eventId', 'event_id', 'uuid']),
      objectId: this.extractFirstString(payload, data, ['objectId', 'object_id', 'id']),
      orderId: this.extractOrderId(payload, data),
      subscriptionId: this.extractSubscriptionId(payload, data),
      checkoutId: this.extractFirstString(payload, data, ['checkoutId', 'checkout_id', 'checkout']),
      customerId: this.extractFirstString(payload, data, ['customerId', 'customer_id']),
      customerEmail: this.extractString(customer, ['email']),
      customer,
      productId:
        this.extractString(product, ['id']) ||
        this.extractFirstString(payload, data, ['productId', 'product_id']),
      offerId: this.extractOfferId(payload, data),
      refId: this.extractFirstString(payload, data, ['refId', 'ref_id']),
      sck: this.extractFirstString(payload, data, ['sck', 'subscriptionId', 'localSubscriptionId']),
      paymentMethod: this.extractFirstString(payload, data, ['paymentMethod', 'payment_method']),
      amount: this.extractAmount(payload, data),
      status: this.extractFirstString(payload, data, ['status']),
      paidAt: this.extractDate(data, ['paidAt', 'paid_at']),
      canceledAt: this.extractDate(data, ['canceledAt', 'canceled_at']),
      currentPeriodStart: this.extractDate(data, ['currentPeriodStart', 'current_period_start', 'periodStart']),
      currentPeriodEnd: this.extractDate(data, ['currentPeriodEnd', 'current_period_end', 'periodEnd']),
      shouldActivate: ['purchase_approved', 'subscription_renewed'].includes(eventType),
      targetStatus,
      rawPayload: input,
    };
  }

  private normalizeEvent(value: string) {
    const normalized = value
      .trim()
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, '_');

    const byPortugueseName: Record<string, string> = {
      compra_aprovada: 'purchase_approved',
      compra_recusada: 'purchase_refused',
      assinatura_criada: 'subscription_created',
      assinatura_cancelada: 'subscription_canceled',
      assinatura_renovada: 'subscription_renewed',
    };

    return EVENT_ALIASES[normalized] || byPortugueseName[normalized] || normalized;
  }

  private mapStatus(eventType: string) {
    const map: Record<string, SubscriptionStatus> = {
      purchase_approved: SubscriptionStatus.ACTIVE,
      subscription_created: SubscriptionStatus.PENDING,
      subscription_renewed: SubscriptionStatus.ACTIVE,
      subscription_canceled: SubscriptionStatus.CANCELLED,
      subscription_renewal_refused: SubscriptionStatus.FAILED,
      purchase_refused: SubscriptionStatus.FAILED,
      refund: SubscriptionStatus.REFUNDED,
      chargeback: SubscriptionStatus.DISPUTED,
      checkout_abandonment: SubscriptionStatus.PENDING,
      pix_gerado: SubscriptionStatus.PENDING,
      boleto_gerado: SubscriptionStatus.PENDING,
      picpay_gerado: SubscriptionStatus.PENDING,
      openfinance_nubank_gerado: SubscriptionStatus.PENDING,
    };
    return map[eventType] || null;
  }

  private extractData(payload: Record<string, unknown>) {
    const data = payload.data || payload.object || payload.payload || payload.order;
    return data && typeof data === 'object' ? (data as Record<string, unknown>) : payload;
  }

  private extractCustomer(...sources: Record<string, unknown>[]) {
    for (const source of sources) {
      const customer = source.customer;
      if (customer && typeof customer === 'object') return customer as Record<string, unknown>;
    }
    return {};
  }

  private extractProduct(...sources: Record<string, unknown>[]) {
    for (const source of sources) {
      const product = source.product;
      if (product && typeof product === 'object') return product as Record<string, unknown>;
      if (typeof product === 'string') return { id: product };
    }
    return {};
  }

  private extractOrderId(payload: Record<string, unknown>, data: Record<string, unknown>) {
    return (
      this.extractFirstString(payload, data, ['orderId', 'order_id']) ||
      (this.looksLikeOrder(data) ? this.extractString(data, ['id']) : null)
    );
  }

  private extractSubscriptionId(payload: Record<string, unknown>, data: Record<string, unknown>) {
    return this.extractFirstString(payload, data, ['providerSubscriptionId', 'subscriptionId', 'subscription_id', 'subscription']);
  }

  private extractOfferId(payload: Record<string, unknown>, data: Record<string, unknown>) {
    const offer = data.offer || payload.offer;
    if (typeof offer === 'string') return offer;
    if (offer && typeof offer === 'object') {
      return this.extractString(offer as Record<string, unknown>, ['id']);
    }
    return this.extractFirstString(payload, data, ['offerId', 'offer_id']);
  }

  private extractAmount(payload: Record<string, unknown>, data: Record<string, unknown>) {
    const raw = this.extractFirstString(payload, data, ['amount', 'baseAmount', 'base_amount']);
    if (!raw) return null;
    const parsed = Number(String(raw).replace(',', '.'));
    return Number.isFinite(parsed) ? parsed : null;
  }

  private extractFirstString(
    first: Record<string, unknown>,
    second: Record<string, unknown>,
    keys: string[],
  ) {
    return this.extractString(first, keys) || this.extractString(second, keys);
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

  private authorizationSecret(value: string | null) {
    if (!value) return null;
    return value.replace(/^Bearer\s+/i, '').trim();
  }

  private headerValue(headers: Record<string, unknown>, key: string) {
    const value = headers[key] || headers[key.toLowerCase()];
    return Array.isArray(value) ? String(value[0]) : value ? String(value) : null;
  }

  private safeCompare(a: string, b: string) {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    if (left.length !== right.length) return false;
    return timingSafeEqual(left, right);
  }

  private looksLikeOrder(data: Record<string, unknown>) {
    return Boolean(data.refId || data.checkoutUrl || data.paidAt || data.paymentMethod);
  }

  private asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  }

  private get isProduction() {
    return this.configService.get<string>('NODE_ENV') === 'production';
  }
}
