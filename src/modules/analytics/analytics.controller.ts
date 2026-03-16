import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { AnalyticsService, ProfitRow } from './analytics.service';
import { ActiveCompanyGuard } from '../../common/guards/active-company.guard';

@Controller('analytics')
@UseGuards(ActiveCompanyGuard)
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  @Get('profit-by-product')
  profitByProduct(
    @Req() req: { user: { id: string; companyId?: string | null } },
    @Query('companyId') companyId?: string,
  ): Promise<Record<string, ProfitRow>> {
    const resolvedCompanyId = companyId ?? req.user.companyId ?? undefined;
    return this.analyticsService.profitByProduct(req.user.id, resolvedCompanyId);
  }

  @Get('sales-peak')
  salesPeak(
    @Req() req: { user: { id: string; companyId?: string | null } },
    @Query('companyId') companyId?: string,
  ) {
    const resolvedCompanyId = companyId ?? req.user.companyId ?? undefined;
    return this.analyticsService.salesPeak(req.user.id, resolvedCompanyId);
  }

  @Get('operational-waste')
  operationalWaste(
    @Req() req: { user: { id: string; companyId?: string | null } },
    @Query('companyId') companyId?: string,
  ) {
    const resolvedCompanyId = companyId ?? req.user.companyId ?? undefined;
    return this.analyticsService.operationalWaste(req.user.id, resolvedCompanyId);
  }

  @Get('margin')
  margin(
    @Req() req: { user: { id: string; companyId?: string | null } },
    @Query('companyId') companyId?: string,
  ) {
    const resolvedCompanyId = companyId ?? req.user.companyId ?? undefined;
    return this.analyticsService.margin(req.user.id, resolvedCompanyId);
  }
}
