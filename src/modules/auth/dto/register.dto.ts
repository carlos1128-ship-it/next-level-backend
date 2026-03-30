import { IsEmail, IsNotEmpty, IsOptional, IsString, Matches, MinLength } from 'class-validator';
import { z } from 'zod';
import { sanitizeText } from '../../../common/utils/sanitize-text.util';

const optionalTrimmedText = z
  .string()
  .trim()
  .transform(sanitizeText)
  .optional()
  .or(z.literal('').transform(() => undefined));

export class RegisterDto {
  static schema = z.object({
    email: z.string().trim().email('E-mail invalido'),
    password: z.string().min(8, 'Senha deve ter no minimo 8 caracteres'),
    companyName: z.string().trim().min(1, 'Nome da empresa e obrigatorio').transform(sanitizeText),
    companySlug: z
      .string()
      .trim()
      .regex(/^[a-z0-9-]+$/, 'Slug da empresa deve conter apenas letras minusculas, numeros e hifen')
      .optional()
      .or(z.literal('').transform(() => undefined)),
    name: optionalTrimmedText,
  });

  @IsEmail({}, { message: 'E-mail invalido' })
  @IsNotEmpty()
  email!: string;

  @IsString()
  @MinLength(8, { message: 'Senha deve ter no minimo 8 caracteres' })
  password!: string;

  @IsString()
  @IsNotEmpty({ message: 'Nome da empresa e obrigatorio' })
  companyName!: string;

  @IsOptional()
  @IsString()
  @Matches(/^[a-z0-9-]+$/, {
    message: 'Slug da empresa deve conter apenas letras minusculas, numeros e hifen',
  })
  companySlug?: string;

  @IsOptional()
  @IsString()
  name?: string;
}
