import { IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export enum DetailLevel {
  low = 'low',
  medium = 'medium',
  high = 'high',
}

export enum UserNiche {
  ECOMMERCE = 'ECOMMERCE',
  MEDICINA = 'MEDICINA',
  SERVICOS = 'SERVICOS',
  EDUCACAO = 'EDUCACAO',
  OUTROS = 'OUTROS',
}

export class UpdateProfileDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  name?: string;

  @IsOptional()
  @IsEnum(DetailLevel)
  detailLevel?: DetailLevel;

  @IsOptional()
  @IsEnum(UserNiche)
  niche?: UserNiche;
}
