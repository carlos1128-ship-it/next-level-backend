import { IsNumber, IsOptional, IsString, Min } from 'class-validator';
import {
  TransformOptionalLimit,
  TransformOptionalNonNegativeNumber,
  TransformOptionalPage,
} from '../../../common/transformers/query-params.transform';

export class ListProductsDto {
  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsString()
  category?: string;

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
  @TransformOptionalNonNegativeNumber()
  @IsNumber()
  minPrice?: number;

  @IsOptional()
  @TransformOptionalNonNegativeNumber()
  @IsNumber()
  maxPrice?: number;

  @IsOptional()
  @IsString()
  companyId?: string;
}
