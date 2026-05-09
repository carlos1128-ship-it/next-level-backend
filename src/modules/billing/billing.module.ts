import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AbacatePayService } from './abacatepay.service';
import { BillingController } from './billing.controller';
import { BillingPlansService } from './billing-plans.service';
import { BillingService } from './billing.service';

@Module({
  imports: [PrismaModule],
  controllers: [BillingController],
  providers: [AbacatePayService, BillingPlansService, BillingService],
  exports: [BillingService, BillingPlansService],
})
export class BillingModule {}
