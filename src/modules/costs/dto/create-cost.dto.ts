import { IsDateString, IsNumber, IsOptional, IsString, Min } from 'class-validator';

export class CreateCostDto {
  @IsString()
  name!: string;

  @IsOptional()
  @IsString()
  category?: string;

  @IsNumber()
  @Min(0)
  amount!: number;

  @IsDateString()
  date!: string;

  @IsOptional()
  @IsString()
  companyId?: string;
}
