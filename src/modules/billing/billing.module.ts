import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { BillingController } from './billing.controller';
import { BillingPlansService } from './billing-plans.service';
import { BillingService } from './billing.service';
import { PlanEntitlementsService } from './plan-entitlements.service';
import { StripeService } from './stripe.service';

@Module({
  imports: [PrismaModule],
  controllers: [BillingController],
  providers: [
    StripeService,
    PlanEntitlementsService,
    BillingPlansService,
    BillingService,
  ],
  exports: [BillingService, BillingPlansService, PlanEntitlementsService],
})
export class BillingModule {}
