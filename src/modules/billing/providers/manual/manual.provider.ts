import { BadRequestException, Injectable } from '@nestjs/common';
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
export class ManualProvider implements PaymentProviderAdapter {
  readonly provider = 'MANUAL' as const;

  isCheckoutEnabled() {
    return false;
  }

  async createCheckout(_input: CreateCheckoutInput): Promise<CreateCheckoutResult> {
    throw new BadRequestException({
      code: 'PAYMENT_PROVIDER_UNAVAILABLE',
      message: 'Gateway de pagamento temporariamente indisponivel.',
    });
  }

  async cancelSubscription(_input: CancelSubscriptionInput): Promise<CancelSubscriptionResult> {
    return { success: true };
  }

  async changePlan(input: ChangePlanInput): Promise<ChangePlanResult> {
    return this.createCheckout(input);
  }

  async verifyWebhook(_input: VerifyWebhookInput): Promise<VerifiedWebhookResult> {
    return { valid: false, provider: this.provider, reason: 'manual_provider' };
  }

  async mapWebhookEvent(input: unknown): Promise<BillingWebhookEvent> {
    return {
      provider: this.provider,
      eventType: 'unknown',
      rawEventType: 'unknown',
      shouldActivate: false,
      rawPayload: input,
    };
  }
}
