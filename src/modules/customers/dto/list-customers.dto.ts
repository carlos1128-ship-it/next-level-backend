import { IsNumber, IsOptional, IsString, Min } from 'class-validator';
import {
  TransformOptionalLimit,
  TransformOptionalPage,
} from '../../../common/transformers/query-params.transform';

export class ListCustomersDto {
  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsString()
  companyId?: string;

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
}
