import { BillingCycle } from '@prisma/client';
import { IsEnum, IsOptional, IsString } from 'class-validator';

export class ChangePlanDto {
  @IsString()
  planKey!: string;

  @IsEnum(BillingCycle)
  billingCycle!: BillingCycle;

  @IsOptional()
  @IsString()
  companyId?: string;
}
