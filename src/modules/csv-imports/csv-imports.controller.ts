import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ActiveCompanyGuard } from '../../common/guards/active-company.guard';
import { SaveCsvImportMappingDto } from './dto/save-csv-import-mapping.dto';
import { UploadCsvImportDto } from './dto/upload-csv-import.dto';
import { CsvImportsService } from './csv-imports.service';

type RequestUser = {
  id?: string;
  userId?: string;
  companyId?: string | null;
};

@Controller('imports/csv')
@UseGuards(ActiveCompanyGuard)
export class CsvImportsController {
  constructor(private readonly csvImportsService: CsvImportsService) {}

  @Post('upload')
  @UseInterceptors(FileInterceptor('file'))
  upload(
    @Req() req: { user: RequestUser },
    @Body() body: UploadCsvImportDto,
    @UploadedFile() file?: { buffer: Buffer; originalname: string; mimetype: string; size: number },
  ) {
    return this.csvImportsService.uploadCsv(
      this.resolveUserId(req.user),
      body.companyId || req.user.companyId || '',
      body.dataType,
      file,
    );
  }

  @Post(':jobId/mapping')
  saveMapping(
    @Param('jobId') jobId: string,
    @Req() req: { user: RequestUser },
    @Body() body: SaveCsvImportMappingDto,
    @Query('companyId') companyId?: string,
  ) {
    return this.csvImportsService.saveMapping(
      this.resolveUserId(req.user),
      companyId || req.user.companyId || '',
      jobId,
      body.mapping,
    );
  }

  @Post(':jobId/confirm')
  confirm(
    @Param('jobId') jobId: string,
    @Req() req: { user: RequestUser },
    @Query('companyId') companyId?: string,
  ) {
    return this.csvImportsService.confirmImport(
      this.resolveUserId(req.user),
      companyId || req.user.companyId || '',
      jobId,
    );
  }

  @Get(':jobId')
  getJob(
    @Param('jobId') jobId: string,
    @Req() req: { user: RequestUser },
    @Query('companyId') companyId?: string,
  ) {
    return this.csvImportsService.getJob(
      this.resolveUserId(req.user),
      companyId || req.user.companyId || '',
      jobId,
    );
  }

  @Get()
  listJobs(
    @Req() req: { user: RequestUser },
    @Query('companyId') companyId?: string,
  ) {
    return this.csvImportsService.listJobs(
      this.resolveUserId(req.user),
      companyId || req.user.companyId || '',
    );
  }

  private resolveUserId(user: RequestUser): string {
    return user.id || user.userId || '';
  }
}
