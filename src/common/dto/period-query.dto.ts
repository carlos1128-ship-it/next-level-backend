import { IsDateString, IsOptional, IsString } from 'class-validator';

export class PeriodQueryDto {
  @IsOptional()
  @IsDateString()
  start?: string;

  @IsOptional()
  @IsDateString()
  end?: string;

  @IsOptional()
  @IsString()
  companyId?: string;
}
