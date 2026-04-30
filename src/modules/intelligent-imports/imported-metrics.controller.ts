import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { ActiveCompanyGuard } from '../../common/guards/active-company.guard';
import { IntelligentImportsService } from './intelligent-imports.service';

type RequestUser = {
  id?: string;
  userId?: string;
  companyId?: string | null;
};

@Controller('imported-metrics')
@UseGuards(ActiveCompanyGuard)
export class ImportedMetricsController {
  constructor(private readonly intelligentImportsService: IntelligentImportsService) {}

  @Get()
  list(@Req() req: { user: RequestUser }) {
    return this.intelligentImportsService.listImportedMetrics(
      req.user.id || req.user.userId || '',
      req.user.companyId || '',
    );
  }
}
