import {
  IsDateString,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  MaxLength,
} from 'class-validator';

/**
 * DTO para criação manual de venda (POST /api/sales).
 * company_id vem do JWT; channel é sempre 'manual'.
 */
export class CreateSaleDto {
  /** Valor da venda. Deve ser maior que zero. */
  @IsNumber()
  @Min(0.01, { message: 'O valor deve ser maior que zero' })
  amount: number;

  /** Nome do produto (opcional). */
  @IsOptional()
  @IsString()
  @MaxLength(255)
  productName?: string;

  /** Categoria para agrupamento no dashboard (opcional). */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  category?: string;

  /** Data/hora real em que a venda ocorreu (ISO 8601). */
  @IsDateString({}, { message: 'Data da venda inválida' })
  occurredAt: string;
}
