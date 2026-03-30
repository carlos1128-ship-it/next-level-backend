import {
  IsDateString,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

export class UpdateSaleDto {
  @IsOptional()
  @IsNumber()
  @Min(0.01, { message: 'O valor deve ser maior que zero' })
  amount?: number;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  productName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  category?: string;

  @IsOptional()
  @IsDateString({}, { message: 'Data da venda invalida' })
  occurredAt?: string;
}
