import { IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';

export class ChatRequestDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(10, { message: 'companyId invalido' })
  @MaxLength(60, { message: 'companyId invalido' })
  companyId: string;

  @IsString()
  @IsNotEmpty({ message: 'A mensagem nao pode estar vazia' })
  @MaxLength(2000)
  message: string;
}
