import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class ChatDto {
  @IsString()
  @IsNotEmpty({ message: 'A mensagem não pode estar vazia' })
  @MaxLength(2000)
  message: string;
}
