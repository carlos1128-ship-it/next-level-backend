import { IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class CreateCompanyDto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name: string;

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
