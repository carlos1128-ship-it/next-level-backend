import { FinancialTransactionType } from '@prisma/client';
import { IsDateString, IsEnum, IsOptional } from 'class-validator';

export class ListTransactionsDto {
  @IsOptional()
  @IsDateString()
  start?: string;

  @IsOptional()
  @IsDateString()
  end?: string;

  @IsOptional()
  @IsEnum(FinancialTransactionType)
  type?: FinancialTransactionType;
}
