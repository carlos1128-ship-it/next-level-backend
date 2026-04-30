import { IsIn, IsOptional, IsString } from 'class-validator';
import { EXPECTED_CATEGORY_VALUES } from '../intelligent-imports.constants';

export class UploadIntelligentImportFileDto {
  @IsOptional()
  @IsString()
  @IsIn(EXPECTED_CATEGORY_VALUES)
  expectedCategory?: (typeof EXPECTED_CATEGORY_VALUES)[number];
}
