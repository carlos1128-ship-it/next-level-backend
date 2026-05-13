import { BillingCycle } from '@prisma/client';
import { IsEnum, IsOptional, IsString } from 'class-validator';

export class CreateSubscriptionCheckoutDto {
  @IsString()
  planKey!: string;

  @IsEnum(BillingCycle)
  billingCycle!: BillingCycle;

  @IsOptional()
  @IsString()
  companyId?: string;
}
