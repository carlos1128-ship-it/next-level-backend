import { Controller, Post, Body, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { ReportService } from './report.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';

@Controller('report')
@UseGuards(JwtAuthGuard)
export class ReportController {
  constructor(private readonly reportService: ReportService) {}

  @Post('margin-pdf')
  async downloadMarginPdf(
    @Body() body: any,
    @Res() res: Response
  ) {
    const { companyName, productName, sellingPrice, costPrice, taxes, shipping, profit, margin } = body;
    
    const pdfBuffer = await this.reportService.generateMarginReportPdf(
      companyName || 'Sua Empresa',
      productName || 'Produto',
      Number(sellingPrice) || 0,
      Number(costPrice) || 0,
      Number(taxes) || 0,
      Number(shipping) || 0,
      Number(profit) || 0,
      Number(margin) || 0,
    );

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="relatorio-margem-${Date.now()}.pdf"`,
      'Content-Length': pdfBuffer.length,
    });

    res.end(pdfBuffer);
  }
}
