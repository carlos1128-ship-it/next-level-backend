import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AbacatePayService } from './abacatepay.service';
import { BillingController } from './billing.controller';
import { BillingPlansService } from './billing-plans.service';
import { BillingService } from './billing.service';
import { AbacatePayProvider } from './providers/abacatepay/abacatepay.provider';
import { CaktoAuthService } from './providers/cakto/cakto-auth.service';
import { CaktoProvider } from './providers/cakto/cakto.provider';
import { CaktoWebhookService } from './providers/cakto/cakto-webhook.service';
import { ManualProvider } from './providers/manual/manual.provider';
import { PaymentProviderResolver } from './providers/payment-provider.resolver';
import { PlanEntitlementsService } from './plan-entitlements.service';

@Module({
  imports: [PrismaModule],
  controllers: [BillingController],
  providers: [
    AbacatePayService,
    AbacatePayProvider,
    CaktoAuthService,
    CaktoProvider,
    CaktoWebhookService,
    ManualProvider,
    PaymentProviderResolver,
    PlanEntitlementsService,
    BillingPlansService,
    BillingService,
  ],
  exports: [BillingService, BillingPlansService, PlanEntitlementsService],
})
export class BillingModule {}
