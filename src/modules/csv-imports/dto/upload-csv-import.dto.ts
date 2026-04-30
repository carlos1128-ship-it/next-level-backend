import { IsEnum, IsNotEmpty, IsString } from 'class-validator';
import {
  CSV_IMPORT_DATA_TYPES,
  CsvImportDataTypeValue,
} from '../csv-imports.constants';

export class UploadCsvImportDto {
  @IsEnum(CSV_IMPORT_DATA_TYPES, { message: 'dataType invalido' })
  dataType!: CsvImportDataTypeValue;

  @IsString()
  @IsNotEmpty()
  companyId!: string;
}
