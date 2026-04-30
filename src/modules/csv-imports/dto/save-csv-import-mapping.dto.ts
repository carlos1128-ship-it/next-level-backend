import { IsNotEmpty, IsObject } from 'class-validator';

export class SaveCsvImportMappingDto {
  @IsObject()
  @IsNotEmpty()
  mapping!: Record<string, string>;
}
