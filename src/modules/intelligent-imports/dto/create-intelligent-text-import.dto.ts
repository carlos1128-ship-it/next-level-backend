import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { EXPECTED_CATEGORY_VALUES } from '../intelligent-imports.constants';

export class CreateIntelligentTextImportDto {
  @IsString()
  @MinLength(3)
  @MaxLength(50000)
  text!: string;

  @IsOptional()
  @IsString()
  @IsIn(EXPECTED_CATEGORY_VALUES)
  expectedCategory?: (typeof EXPECTED_CATEGORY_VALUES)[number];
}
