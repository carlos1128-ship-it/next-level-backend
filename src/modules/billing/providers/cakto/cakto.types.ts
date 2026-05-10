export type CaktoTokenResponse = {
  access_token: string;
  expires_in: number;
  token_type: string;
  scope?: string;
};

export type CaktoCustomer = {
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  docType?: string | null;
  docNumber?: string | null;
};

export type CaktoProduct = {
  id?: string;
  name?: string;
  type?: 'unique' | 'subscription' | string;
  paymentMethods?: string[];
};

export type CaktoOffer = {
  id: string;
  name?: string;
  price?: number;
  product?: string | CaktoProduct;
  status?: string;
  type?: 'unique' | 'subscription' | string;
  intervalType?: string;
  interval?: number;
  recurrence_period?: number;
  quantity_recurrences?: number;
  trial_days?: number;
  max_retries?: number;
  retry_interval?: number;
};

export type CaktoOrder = {
  id: string;
  refId?: string | null;
  status?: string | null;
  type?: 'unique' | 'subscription' | string;
  offer_type?: string | null;
  amount?: string | number | null;
  baseAmount?: string | number | null;
  product?: CaktoProduct | string | null;
  checkout?: string | number | null;
  subscription?: string | number | null;
  subscription_period?: string | null;
  paymentMethod?: string | null;
  customer?: CaktoCustomer | null;
  paidAt?: string | null;
  refundedAt?: string | null;
  chargedbackAt?: string | null;
  canceledAt?: string | null;
  checkoutUrl?: string | null;
  sck?: string | null;
  utm_source?: string | null;
  utm_medium?: string | null;
  utm_campaign?: string | null;
  utm_term?: string | null;
  utm_content?: string | null;
};

export type CaktoWebhookPayload = Record<string, unknown>;
