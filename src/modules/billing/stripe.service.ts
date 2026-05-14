import {
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';

export type StripeCheckoutSessionRecord = {
  id: string;
  url: string | null;
  subscription?: unknown;
  customer?: unknown;
  metadata?: Record<string, string> | null;
};

export type StripeSubscriptionRecord = {
  id: string;
  status: string;
  customer?: unknown;
  metadata?: Record<string, string> | null;
  current_period_start?: number;
  current_period_end?: number;
  cancel_at_period_end?: boolean;
  canceled_at?: number | null;
  items?: {
    data?: Array<{
      price?: {
        id?: string;
        recurring?: {
          interval?: string | null;
        } | null;
      } | null;
    }>;
  };
};

export type StripeInvoiceRecord = {
  subscription?: unknown;
  parent?: {
    subscription_details?: {
      subscription?: unknown;
    } | null;
  } | null;
};

export type StripeWebhookEventRecord = {
  id: string;
  type: string;
  livemode: boolean;
  data: {
    object: unknown;
  };
};

type CheckoutInput = {
  customer: string;
  priceId: string;
  successUrl: string;
  cancelUrl: string;
  clientReferenceId: string;
  metadata: Record<string, string>;
};

@Injectable()
export class StripeService {
  private readonly stripe: Stripe.Stripe | null;

  constructor(private readonly configService: ConfigService) {
    const secretKey = this.configService.get<string>('STRIPE_SECRET_KEY')?.trim();
    this.stripe = secretKey ? new Stripe(secretKey) : null;
  }

  isConfigured() {
    return Boolean(this.stripe);
  }

  async createCustomer(input: {
    email?: string;
    name?: string;
    metadata?: Record<string, string>;
  }) {
    return this.client().customers.create({
      email: input.email,
      name: input.name,
      metadata: input.metadata,
    });
  }

  async createSubscriptionCheckoutSession(input: CheckoutInput): Promise<StripeCheckoutSessionRecord> {
    const session = await this.client().checkout.sessions.create({
      mode: 'subscription',
      customer: input.customer,
      line_items: [{ price: input.priceId, quantity: 1 }],
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      client_reference_id: input.clientReferenceId,
      allow_promotion_codes: true,
      metadata: input.metadata,
      subscription_data: {
        metadata: input.metadata,
      },
    });

    if (!session.url) {
      throw new ServiceUnavailableException('Nao foi possivel abrir o checkout.');
    }

    return session as StripeCheckoutSessionRecord;
  }

  async createPortalSession(input: { customer: string; returnUrl: string }) {
    return this.client().billingPortal.sessions.create({
      customer: input.customer,
      return_url: input.returnUrl,
    });
  }

  async retrieveSubscription(subscriptionId: string): Promise<StripeSubscriptionRecord> {
    const subscription = await this.client().subscriptions.retrieve(subscriptionId, {
      expand: ['items.data.price'],
    });
    return subscription as StripeSubscriptionRecord;
  }

  async cancelAtPeriodEnd(subscriptionId: string) {
    return this.client().subscriptions.update(subscriptionId, {
      cancel_at_period_end: true,
    });
  }

  constructWebhookEvent(rawBody: Buffer | undefined, signature: string | undefined): StripeWebhookEventRecord {
    const webhookSecret = this.configService.get<string>('STRIPE_WEBHOOK_SECRET')?.trim();
    if (!webhookSecret) {
      throw new ServiceUnavailableException('Webhook Stripe nao configurado.');
    }
    if (!rawBody || !signature) {
      throw new UnauthorizedException({
        code: 'INVALID_STRIPE_SIGNATURE',
        message: 'Webhook Stripe invalido.',
      });
    }

    try {
      return this.client().webhooks.constructEvent(rawBody, signature, webhookSecret) as StripeWebhookEventRecord;
    } catch {
      throw new UnauthorizedException({
        code: 'INVALID_STRIPE_SIGNATURE',
        message: 'Assinatura do webhook Stripe invalida.',
      });
    }
  }

  private client() {
    if (!this.stripe) {
      throw new ServiceUnavailableException('Stripe nao configurado.');
    }
    return this.stripe;
  }
}
