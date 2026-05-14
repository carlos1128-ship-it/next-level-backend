import { BillingCycle } from '@prisma/client';
import { IsEnum, IsOptional, IsString } from 'class-validator';

export class ChangePlanDto {
  @IsOptional()
  @IsString()
  planKey?: string;

  @IsOptional()
  @IsString()
  targetPlanKey?: string;

  @IsEnum(BillingCycle)
  billingCycle!: BillingCycle;

  @IsOptional()
  @IsString()
  companyId?: string;
}
