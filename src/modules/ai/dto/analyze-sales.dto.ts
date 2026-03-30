import { IsNotEmpty, IsObject } from 'class-validator';

export class AnalyzeSalesDto {
  @IsObject()
  @IsNotEmpty()
  data: Record<string, unknown>;
}
