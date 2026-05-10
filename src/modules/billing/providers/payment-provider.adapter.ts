import { BillingCycle, SubscriptionStatus } from '@prisma/client';
import { BillingPlanKey } from '../constants/billing.constants';

export type BillingPaymentProvider =
  | 'MANUAL'
  | 'ABACATEPAY'
  | 'CAKTO'
  | 'ASAAS'
  | 'MERCADO_PAGO';

export type CreateCheckoutInput = {
  userId: string;
  companyId: string | null;
  userEmail?: string | null;
  subscriptionId: string;
  externalId: string;
  planKey: BillingPlanKey;
  billingCycle: BillingCycle;
  amountInCents: number;
  currency: string;
  providerProductId?: string | null;
  providerOfferId?: string | null;
  providerCheckoutUrl?: string | null;
  providerMetadata?: Record<string, unknown> | null;
  legacyProductId?: string | null;
};

export type CreateCheckoutResult = {
  checkoutUrl: string;
  provider: BillingPaymentProvider;
  providerCheckoutId?: string | null;
  providerSubscriptionId?: string | null;
  providerCustomerId?: string | null;
  providerOrderId?: string | null;
  providerOfferId?: string | null;
  providerProductId?: string | null;
  providerCheckoutUrl?: string | null;
  providerRefId?: string | null;
  providerSck?: string | null;
  providerMetadata?: Record<string, unknown> | null;
};

export type CancelSubscriptionInput = {
  subscriptionId: string;
  providerSubscriptionId?: string | null;
};

export type CancelSubscriptionResult = {
  success: boolean;
  providerMetadata?: Record<string, unknown> | null;
};

export type ChangePlanInput = CreateCheckoutInput & {
  currentProviderSubscriptionId?: string | null;
};

export type ChangePlanResult = CreateCheckoutResult;

export type VerifyWebhookInput = {
  headers: Record<string, unknown>;
  query?: Record<string, unknown>;
  body: unknown;
  rawBody?: Buffer;
};

export type VerifiedWebhookResult = {
  valid: boolean;
  provider: BillingPaymentProvider;
  reason?: string;
};

export type BillingWebhookEvent = {
  provider: BillingPaymentProvider;
  eventType: string;
  rawEventType: string;
  eventId?: string | null;
  objectId?: string | null;
  orderId?: string | null;
  subscriptionId?: string | null;
  checkoutId?: string | null;
  customerId?: string | null;
  customerEmail?: string | null;
  customer?: Record<string, unknown> | null;
  productId?: string | null;
  offerId?: string | null;
  refId?: string | null;
  sck?: string | null;
  paymentMethod?: string | null;
  amount?: number | null;
  status?: string | null;
  paidAt?: Date | null;
  canceledAt?: Date | null;
  currentPeriodStart?: Date | null;
  currentPeriodEnd?: Date | null;
  shouldActivate: boolean;
  targetStatus?: SubscriptionStatus | null;
  rawPayload: unknown;
};

export interface PaymentProviderAdapter {
  readonly provider: BillingPaymentProvider;
  isCheckoutEnabled(): boolean;
  createCheckout(input: CreateCheckoutInput): Promise<CreateCheckoutResult>;
  cancelSubscription(input: CancelSubscriptionInput): Promise<CancelSubscriptionResult>;
  changePlan(input: ChangePlanInput): Promise<ChangePlanResult>;
  verifyWebhook(input: VerifyWebhookInput): Promise<VerifiedWebhookResult>;
  mapWebhookEvent(input: unknown): Promise<BillingWebhookEvent>;
}
