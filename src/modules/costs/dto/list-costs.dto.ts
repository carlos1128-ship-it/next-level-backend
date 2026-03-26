import { IsDateString, IsNumber, IsOptional, IsString, Min } from 'class-validator';
import {
  TransformOptionalLimit,
  TransformOptionalPage,
} from '../../../common/transformers/query-params.transform';

export class ListCostsDto {
  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsString()
  category?: string;

  @IsOptional()
  @IsDateString()
  startDate?: string;

  @IsOptional()
  @IsDateString()
  endDate?: string;

  @IsOptional()
  @TransformOptionalPage()
  @IsNumber()
  @Min(1)
  page?: number;

  @IsOptional()
  @TransformOptionalLimit(100)
  @IsNumber()
  @Min(1)
  limit?: number;

  @IsOptional()
  @IsString()
  companyId?: string;
}
