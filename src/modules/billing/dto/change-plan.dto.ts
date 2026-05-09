import { BillingCycle } from '@prisma/client';
import { IsEnum, IsString } from 'class-validator';

export class ChangePlanDto {
  @IsString()
  planKey!: string;

  @IsEnum(BillingCycle)
  billingCycle!: BillingCycle;
}
