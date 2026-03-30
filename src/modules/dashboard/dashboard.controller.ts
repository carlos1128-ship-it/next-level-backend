import { Controller, Get, Param, Query } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { DashboardService } from './dashboard.service';

@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get('summary')
  async getSummary(
    @CurrentUser('sub') userId: string,
    @Query('companyId') companyId?: string,
    @Query('period') period?: string,
  ) {
    return this.dashboardService.getSummary(userId, companyId, period);
  }

  @Get('metrics')
  async getMetrics(
    @CurrentUser('sub') userId: string,
    @Query('companyId') companyId?: string,
    @Query('period') period?: string,
  ) {
    return this.dashboardService.getSummary(userId, companyId, period);
  }

  @Get('company/:companyId')
  async getDashboardByCompany(@Param('companyId') companyId: string) {
    return this.dashboardService.getDashboard(companyId);
  }
}
