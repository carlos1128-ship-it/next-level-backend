import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { AnalyticsService } from './analytics.service';
import { ActiveCompanyGuard } from '../../common/guards/active-company.guard';

@Controller('analytics')
@UseGuards(ActiveCompanyGuard)
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  @Get('profit-by-product')
  profitByProduct(
    @Req() req: { user: { id: string; companyId?: string | null } },
    @Query('companyId') companyId?: string,
  ) {
    return this.analyticsService.profitByProduct(req.user.id, companyId || req.user.companyId);
  }

  @Get('sales-peak')
  salesPeak(
    @Req() req: { user: { id: string; companyId?: string | null } },
    @Query('companyId') companyId?: string,
  ) {
    return this.analyticsService.salesPeak(req.user.id, companyId || req.user.companyId);
  }

  @Get('operational-waste')
  operationalWaste(
    @Req() req: { user: { id: string; companyId?: string | null } },
    @Query('companyId') companyId?: string,
  ) {
    return this.analyticsService.operationalWaste(req.user.id, companyId || req.user.companyId);
  }

  @Get('margin')
  margin(
    @Req() req: { user: { id: string; companyId?: string | null } },
    @Query('companyId') companyId?: string,
  ) {
    return this.analyticsService.margin(req.user.id, companyId || req.user.companyId);
  }
}
