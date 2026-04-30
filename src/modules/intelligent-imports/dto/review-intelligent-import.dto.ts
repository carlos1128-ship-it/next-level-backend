import { Type } from 'class-transformer';
import {
  IsArray,
  IsDateString,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

class ReviewMetricDto {
  @IsString()
  metricKey!: string;

  @IsString()
  label!: string;

  value!: unknown;

  @IsString()
  unit!: string;

  @IsOptional()
  @IsString()
  currency?: string | null;

  @IsOptional()
  @IsNumber()
  confidence?: number;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  sourceText?: string;
}

class ReviewEntityDto {
  @IsString()
  entityType!: string;

  @IsObject()
  data!: Record<string, unknown>;

  @IsOptional()
  @IsNumber()
  confidence?: number;
}

export class ReviewIntelligentImportDto {
  @IsOptional()
  @IsString()
  expectedCategory?: string;

  @IsOptional()
  @IsString()
  detectedCategory?: string;

  @IsOptional()
  @IsString()
  detectedPlatform?: string;

  @IsOptional()
  @IsDateString()
  detectedPeriodStart?: string | null;

  @IsOptional()
  @IsDateString()
  detectedPeriodEnd?: string | null;

  @IsOptional()
  @IsNumber()
  confidence?: number;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  summary?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReviewMetricDto)
  metrics?: ReviewMetricDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReviewEntityDto)
  entities?: ReviewEntityDto[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  warnings?: string[];
}
