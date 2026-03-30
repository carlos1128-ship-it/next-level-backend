import {
  IsDateString,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateCompanyDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(120)
  name: string;

  @IsString()
  @IsOptional()
  @MinLength(2)
  @MaxLength(80)
  sector?: string;

  @IsString()
  @IsOptional()
  @MinLength(2)
  @MaxLength(80)
  segment?: string;

  @IsString()
  @IsOptional()
  @MinLength(11)
  @MaxLength(18)
  document?: string;

  @IsString()
  @IsOptional()
  @MinLength(3)
  @MaxLength(500)
  description?: string;

  @IsOptional()
  @IsDateString()
  openedAt?: string;

  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  @Matches(/^[a-z0-9-]+$/, {
    message: 'Slug deve conter apenas letras minusculas, numeros e hifen',
  })
  slug?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  currency?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  timezone?: string;
}
