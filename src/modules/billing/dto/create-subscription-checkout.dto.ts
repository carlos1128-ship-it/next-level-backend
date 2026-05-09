import { BillingCycle } from '@prisma/client';
import { IsEnum, IsString } from 'class-validator';

export class CreateSubscriptionCheckoutDto {
  @IsString()
  planKey!: string;

  @IsEnum(BillingCycle)
  billingCycle!: BillingCycle;
}
