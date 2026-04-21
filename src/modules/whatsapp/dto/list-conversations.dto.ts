import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class ListConversationsDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsString()
  status?: string;
}
