import { Controller, Get, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import { Readable } from 'stream';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ExportFinancialQueryDto } from './dto/export-financial-query.dto';
import { ExportService } from './export.service';

@Controller('export')
export class ExportController {
  constructor(private readonly exportService: ExportService) {}

  @Get('financial')
  async exportFinancial(
    @CurrentUser('sub') userId: string,
    @Query() query: ExportFinancialQueryDto,
    @Res() res: Response,
  ) {
    const csv = await this.exportService.getFinancialCsv(userId, query);
    const now = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="financial-export-${now}.csv"`,
    );

    const stream = Readable.from([csv]);
    stream.pipe(res);
  }
}
