import { BillingCycle } from '@prisma/client';
import { BillingPlanKey } from '../constants/billing.constants';

export type AbacatePayMetadata = {
  localSubscriptionId: string;
  userId: string;
  companyId?: string | null;
  planKey: BillingPlanKey;
  billingCycle: BillingCycle;
};

export type CreateAbacatePaySubscriptionParams = {
  productId: string;
  methods: string[];
  customerId?: string | null;
  externalId: string;
  returnUrl: string;
  completionUrl: string;
  metadata: AbacatePayMetadata;
};

export type AbacatePayEnvelope<T> = {
  success?: boolean;
  error?: unknown;
  data?: T;
};

export type AbacatePaySubscriptionCheckout = {
  id: string;
  externalId?: string | null;
  url: string;
  amount?: number;
  status?: string;
  metadata?: Record<string, unknown>;
};
