import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AbacatePayProvider } from './abacatepay/abacatepay.provider';
import { CaktoProvider } from './cakto/cakto.provider';
import { ManualProvider } from './manual/manual.provider';
import {
  BillingPaymentProvider,
  PaymentProviderAdapter,
} from './payment-provider.adapter';

@Injectable()
export class PaymentProviderResolver {
  constructor(
    private readonly configService: ConfigService,
    private readonly manualProvider: ManualProvider,
    private readonly abacatePayProvider: AbacatePayProvider,
    private readonly caktoProvider: CaktoProvider,
  ) {}

  get activeProviderKey(): BillingPaymentProvider {
    return this.normalizeProvider(this.configService.get<string>('BILLING_PAYMENT_PROVIDER'));
  }

  resolve(provider?: string | null): PaymentProviderAdapter {
    const key = provider ? this.normalizeProvider(provider) : this.activeProviderKey;
    if (key === 'ABACATEPAY') return this.abacatePayProvider;
    if (key === 'CAKTO') return this.caktoProvider;
    return this.manualProvider;
  }

  normalizeProvider(value: unknown): BillingPaymentProvider {
    const normalized = String(value || 'MANUAL').trim().toUpperCase();
    if (normalized === 'CACTO') return 'CAKTO';
    if (normalized === 'ABACATEPAY') return 'ABACATEPAY';
    if (normalized === 'CAKTO') return 'CAKTO';
    if (normalized === 'ASAAS') return 'ASAAS';
    if (normalized === 'MERCADO_PAGO' || normalized === 'MERCADOPAGO') return 'MERCADO_PAGO';
    return 'MANUAL';
  }
}
