import { IsNumber, IsOptional, IsString, Min } from 'class-validator';
import { z } from 'zod';
import { sanitizeText } from '../../../common/utils/sanitize-text.util';

const optionalTrimmedText = z
  .string()
  .trim()
  .transform(sanitizeText)
  .optional()
  .or(z.literal('').transform(() => undefined));

export class CreateProductDto {
  static schema = z.object({
    name: z.string().trim().min(1, 'name obrigatorio').transform(sanitizeText),
    sku: optionalTrimmedText,
    category: optionalTrimmedText,
    price: z.coerce.number().positive('price deve ser positivo'),
    cost: z.coerce.number().positive('cost deve ser positivo').optional(),
    companyId: optionalTrimmedText,
  });

  @IsString()
  name!: string;

  @IsOptional()
  @IsString()
  sku?: string;

  @IsOptional()
  @IsString()
  category?: string;

  @IsNumber()
  @Min(0)
  price!: number;

  @IsOptional()
  @IsNumber()
  @Min(0.000001)
  cost?: number;

  @IsOptional()
  @IsString()
  companyId?: string;
}
