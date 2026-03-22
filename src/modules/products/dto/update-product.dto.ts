import { IsNumber, IsOptional, IsString, Min } from 'class-validator';
import { z } from 'zod';
import { sanitizeText } from '../../../common/utils/sanitize-text.util';

const optionalTrimmedText = z
  .string()
  .trim()
  .transform(sanitizeText)
  .optional()
  .or(z.literal('').transform(() => undefined));

export class UpdateProductDto {
  static schema = z.object({
    name: optionalTrimmedText,
    sku: optionalTrimmedText,
    category: optionalTrimmedText,
    price: z.coerce.number().positive('price deve ser positivo').optional(),
    cost: z.union([z.coerce.number().positive('cost deve ser positivo'), z.null()]).optional(),
    companyId: optionalTrimmedText,
  });

  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  sku?: string;

  @IsOptional()
  @IsString()
  category?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  price?: number;

  @IsOptional()
  @IsNumber()
  @Min(0.000001)
  cost?: number;

  @IsOptional()
  @IsString()
  companyId?: string;
}
