import { IsEmail, IsNotEmpty, IsString, MinLength } from 'class-validator';
import { z } from 'zod';

export class LoginDto {
  static schema = z.object({
    email: z.string().trim().email('E-mail invalido'),
    password: z.string().min(6, 'Senha deve ter no minimo 6 caracteres'),
  });

  @IsEmail({}, { message: 'E-mail invalido' })
  @IsNotEmpty()
  email!: string;

  @IsString()
  @MinLength(6, { message: 'Senha deve ter no minimo 6 caracteres' })
  password!: string;
}
