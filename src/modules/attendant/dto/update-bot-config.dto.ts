import { IsBoolean, IsOptional, IsString } from 'class-validator';

export class UpdateBotConfigDto {
  @IsOptional()
  @IsString()
  botName?: string;

  @IsOptional()
  @IsString()
  welcomeMessage?: string;

  @IsOptional()
  @IsString()
  toneOfVoice?: string;

  @IsOptional()
  @IsString()
  instructions?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
