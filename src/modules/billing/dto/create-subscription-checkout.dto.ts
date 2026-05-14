import { BillingCycle } from '@prisma/client';
import { IsEnum, IsOptional, IsString } from 'class-validator';

export class CreateSubscriptionCheckoutDto {
  @IsString()
  planKey!: string;

  @IsOptional()
  @IsEnum(BillingCycle)
  billingCycle?: BillingCycle;

  @IsOptional()
  @IsString()
  billingInterval?: string;

  @IsOptional()
  @IsString()
  companyId?: string;
}
