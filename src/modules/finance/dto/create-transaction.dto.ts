import { FinancialTransactionType } from '@prisma/client';
import {
  IsDateString,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateTransactionDto {
  @IsEnum(FinancialTransactionType)
  type: FinancialTransactionType;

  @IsNumber()
  @Min(0.01, { message: 'O valor deve ser maior que zero' })
  amount: number;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  description: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  category?: string;

  @IsDateString({}, { message: 'Data da transacao invalida' })
  occurredAt: string;
}
