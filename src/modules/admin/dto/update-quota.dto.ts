import { IsDateString, IsEnum, IsInt, IsOptional, Min } from 'class-validator';
import { Plan } from '@prisma/client';

export class UpdateQuotaDto {
  @IsOptional()
  @IsEnum(Plan)
  currentTier?: Plan;

  @IsOptional()
  @IsInt()
  @Min(0)
  llmTokensUsed?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  whatsappMessagesSent?: number;

  @IsOptional()
  @IsDateString()
  billingCycleEnd?: string;
}
