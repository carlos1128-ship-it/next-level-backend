import {
  IsIn,
  IsDateString,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export const TRANSACTION_TYPES = ['income', 'expense'] as const;
export type TransactionType = (typeof TRANSACTION_TYPES)[number];

export class CreateTransactionDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(10, { message: 'companyId invalido' })
  @MaxLength(60, { message: 'companyId invalido' })
  companyId: string;

  @IsString()
  @IsNotEmpty()
  @IsIn(TRANSACTION_TYPES, { message: 'type deve ser income ou expense' })
  type: TransactionType;

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

  @IsOptional()
  @IsDateString({}, { message: 'Data da transacao invalida' })
  occurredAt?: string;

  @IsOptional()
  @IsDateString({}, { message: 'Data da transacao invalida' })
  date: string;
}
