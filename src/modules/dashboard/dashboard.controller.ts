import { Body, Controller, Get, Param, Post, Put, Query } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { JwtPayload } from '../../common/decorators/current-user.decorator';
import { DashboardService } from './dashboard.service';

@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get('summary')
  async getSummary(
    @CurrentUser('sub') userId: string,
    @Query('companyId') companyId?: string,
    @Query('period') period?: string,
    @Query('metrics') metrics?: string,
  ) {
    return this.dashboardService.getSummary(userId, companyId, period, metrics);
  }

  @Get('metrics')
  async getMetrics(
    @CurrentUser() user: JwtPayload,
    @Query('companyId') companyId?: string,
    @Query('period') period?: string,
    @Query('metrics') metrics?: string,
    @Query('comparePrevious') comparePrevious?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    return this.dashboardService.getMetrics(
      user.sub,
      companyId,
      period,
      metrics,
      comparePrevious !== 'false',
      startDate,
      endDate,
      user.companyId,
      Boolean(user.admin),
    );
  }

  @Get('preferences')
  async getPreferences(
    @CurrentUser() user: JwtPayload,
    @Query('companyId') companyId?: string,
  ) {
    return this.dashboardService.getPreferences(
      user.sub,
      companyId,
      user.companyId,
      Boolean(user.admin),
    );
  }

  @Put('preferences')
  async savePreferences(
    @CurrentUser() user: JwtPayload,
    @Body('preferences') preferences: unknown,
    @Query('companyId') companyId?: string,
  ) {
    return this.dashboardService.savePreferences(
      user.sub,
      Array.isArray(preferences) ? preferences : [],
      companyId,
      user.companyId,
      Boolean(user.admin),
    );
  }

  @Post('preferences/reset')
  async resetPreferences(
    @CurrentUser() user: JwtPayload,
    @Query('companyId') companyId?: string,
  ) {
    return this.dashboardService.resetPreferences(
      user.sub,
      companyId,
      user.companyId,
      Boolean(user.admin),
    );
  }

  @Get('company/:companyId')
  async getDashboardByCompany(@Param('companyId') companyId: string) {
    return this.dashboardService.getDashboard(companyId);
  }
}
