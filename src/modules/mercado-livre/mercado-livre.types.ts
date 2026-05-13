export type JsonRecord = Record<string, unknown>;

export type MercadoLivreOAuthState = {
  companyId: string;
  userId: string;
  returnTo: string;
  issuedAt: string;
};

export type MercadoLivreTokenResponse = {
  access_token: string;
  refresh_token: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
  user_id: number | string;
};

export type MercadoLivreProductItem = {
  id: string;
  title: string;
  price: number;
  base_price?: number | null;
  currency_id?: string | null;
  available_quantity?: number | null;
  sold_quantity?: number | null;
  status?: string | null;
  permalink?: string | null;
  category_id?: string | null;
  seller_custom_field?: string | null;
};

export type MercadoLivreSyncSummary = {
  products: number;
  orders: number;
  questions: number;
  reviews: number;
  syncedAt: string;
};
