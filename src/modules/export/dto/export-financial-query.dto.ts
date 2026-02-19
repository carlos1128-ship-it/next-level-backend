import { IsDateString, IsOptional } from 'class-validator';

export class ExportFinancialQueryDto {
  @IsOptional()
  @IsDateString()
  start?: string;

  @IsOptional()
  @IsDateString()
  end?: string;
}
