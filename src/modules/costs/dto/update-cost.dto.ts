import { IsDateString, IsNumber, IsOptional, IsString, Min } from 'class-validator';

export class UpdateCostDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  category?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  amount?: number;

  @IsOptional()
  @IsDateString()
  date?: string;

  @IsOptional()
  @IsString()
  companyId?: string;
}
