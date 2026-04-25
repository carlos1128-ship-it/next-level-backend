import { IsBoolean, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class UpdateBotConfigDto {
  @IsOptional()
  @IsString()
  botName?: string;

  @IsOptional()
  @IsString()
  agentName?: string;

  @IsOptional()
  @IsString()
  welcomeMessage?: string;

  @IsOptional()
  @IsString()
  toneOfVoice?: string;

  @IsOptional()
  @IsString()
  tone?: string;

  @IsOptional()
  @IsString()
  instructions?: string;

  @IsOptional()
  @IsString()
  systemPrompt?: string;

  @IsOptional()
  @IsString()
  companyDescription?: string;

  @IsOptional()
  @IsString()
  model?: string;

  @IsOptional()
  @IsString()
  modelName?: string;

  @IsOptional()
  @IsBoolean()
  internetSearchEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  audioToTextEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  speechToTextEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  imageReadingEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  imageUnderstandingEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  splitResponsesEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  splitRepliesEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  bufferEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  messageBufferEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  humanPauseEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  pauseForHuman?: boolean;

  @IsOptional()
  @IsBoolean()
  attendantActive?: boolean;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsBoolean()
  isOnline?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(300)
  debounceSeconds?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(200)
  contextWindow?: number;
}
