import { IsDateString, IsOptional } from 'class-validator';

export class PeriodQueryDto {
  @IsOptional()
  @IsDateString()
  start?: string;

  @IsOptional()
  @IsDateString()
  end?: string;
}
