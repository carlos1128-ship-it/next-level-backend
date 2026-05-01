import {
  IsEnum,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { SaleAIAttributionSource } from '@prisma/client';

export class SaleAIAttributionDto {
  @IsOptional()
  @IsString()
  conversationId?: string;

  @IsOptional()
  @IsString()
  leadId?: string;

  @IsOptional()
  @IsString()
  messageId?: string;

  @IsOptional()
  @IsEnum(SaleAIAttributionSource)
  source?: SaleAIAttributionSource;

  @IsOptional()
  @IsNumber()
  @Min(0.01)
  attributedRevenue?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  confidence?: number;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}
