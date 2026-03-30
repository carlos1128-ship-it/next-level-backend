import { IsDateString, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class ExportFinancialQueryDto {
  @IsOptional()
  @IsDateString()
  start?: string;

  @IsOptional()
  @IsDateString()
  end?: string;

  @IsOptional()
  @IsString()
  @MinLength(10)
  @MaxLength(60)
  companyId?: string;
}
