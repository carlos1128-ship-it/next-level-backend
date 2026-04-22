import { IsOptional, IsString, MaxLength } from 'class-validator';

export class ConnectWhatsappDto {
  @IsOptional()
  @IsString()
  @MaxLength(80)
  instanceName?: string;
}
