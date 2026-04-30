import { Module } from '@nestjs/common';
import { CsvImportsController } from './csv-imports.controller';
import { CsvImportsService } from './csv-imports.service';

@Module({
  controllers: [CsvImportsController],
  providers: [CsvImportsService],
  exports: [CsvImportsService],
})
export class CsvImportsModule {}
