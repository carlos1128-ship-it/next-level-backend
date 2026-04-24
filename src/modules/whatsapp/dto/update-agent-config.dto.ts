import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class UpdateAgentConfigDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  agentName?: string;

  @IsOptional()
  @IsString()
  companyDescription?: string;

  @IsOptional()
  @IsString()
  welcomeMessage?: string;

  @IsOptional()
  @IsString()
  systemPrompt?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  toneOfVoice?: string;

  @IsOptional()
  @IsBoolean()
  internetSearchEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  isEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  pauseForHuman?: boolean;

  @IsOptional()
  @IsBoolean()
  speechToText?: boolean;

  @IsOptional()
  @IsBoolean()
  speechToTextEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  imageUnderstanding?: boolean;

  @IsOptional()
  @IsBoolean()
  imageUnderstandingEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  splitRepliesEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  messageBufferEnabled?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  modelProvider?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  modelName?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(300)
  debounceSeconds?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(200)
  maxContextMessages?: number;
}
