import { IsArray, IsOptional, IsString } from 'class-validator';

export class TrackMarketDto {
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  productIds?: string[];
}
