import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ActiveCompanyGuard } from '../../common/guards/active-company.guard';
import { CreateIntelligentTextImportDto } from './dto/create-intelligent-text-import.dto';
import { ReviewIntelligentImportDto } from './dto/review-intelligent-import.dto';
import { UploadIntelligentImportFileDto } from './dto/upload-intelligent-import-file.dto';
import { IntelligentImportsService } from './intelligent-imports.service';

type RequestUser = {
  id?: string;
  userId?: string;
  companyId?: string | null;
};

@Controller('intelligent-imports')
@UseGuards(ActiveCompanyGuard)
export class IntelligentImportsController {
  constructor(private readonly intelligentImportsService: IntelligentImportsService) {}

  @Get()
  list(
    @Req() req: { user: RequestUser },
  ) {
    return this.intelligentImportsService.listImports(
      this.resolveUserId(req.user),
      req.user.companyId || '',
    );
  }

  @Post('text')
  createText(
    @Req() req: { user: RequestUser },
    @Body() body: CreateIntelligentTextImportDto,
  ) {
    return this.intelligentImportsService.createTextImport(
      this.resolveUserId(req.user),
      req.user.companyId || '',
      body,
    );
  }

  @Post('file')
  @UseInterceptors(FileInterceptor('file'))
  uploadFile(
    @Req() req: { user: RequestUser },
    @Body() body: UploadIntelligentImportFileDto,
    @UploadedFile() file?: {
      buffer: Buffer;
      originalname: string;
      mimetype: string;
      size: number;
    },
  ) {
    return this.intelligentImportsService.uploadFile(
      this.resolveUserId(req.user),
      req.user.companyId || '',
      body,
      file,
    );
  }

  @Post(':id/analyze')
  analyze(
    @Req() req: { user: RequestUser },
    @Param('id') importId: string,
  ) {
    return this.intelligentImportsService.analyzeImport(
      this.resolveUserId(req.user),
      req.user.companyId || '',
      importId,
    );
  }

  @Get(':id')
  getOne(
    @Req() req: { user: RequestUser },
    @Param('id') importId: string,
  ) {
    return this.intelligentImportsService.getImport(
      this.resolveUserId(req.user),
      req.user.companyId || '',
      importId,
    );
  }

  @Put(':id/review')
  review(
    @Req() req: { user: RequestUser },
    @Param('id') importId: string,
    @Body() body: ReviewIntelligentImportDto,
  ) {
    return this.intelligentImportsService.reviewImport(
      this.resolveUserId(req.user),
      req.user.companyId || '',
      importId,
      body,
    );
  }

  @Post(':id/confirm')
  confirm(
    @Req() req: { user: RequestUser },
    @Param('id') importId: string,
  ) {
    return this.intelligentImportsService.confirmImport(
      this.resolveUserId(req.user),
      req.user.companyId || '',
      importId,
    );
  }

  @Post(':id/reject')
  reject(
    @Req() req: { user: RequestUser },
    @Param('id') importId: string,
  ) {
    return this.intelligentImportsService.rejectImport(
      this.resolveUserId(req.user),
      req.user.companyId || '',
      importId,
    );
  }

  private resolveUserId(user: RequestUser) {
    return user.id || user.userId || '';
  }
}
