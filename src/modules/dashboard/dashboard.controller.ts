import { Controller, Get } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { DashboardService } from './dashboard.service';

@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get('summary')
  async getSummary(@CurrentUser('sub') userId: string) {
    return this.dashboardService.getSummary(userId);
  }

  @Get('metrics')
  async getMetrics(@CurrentUser('sub') userId: string) {
    return this.dashboardService.getSummary(userId);
  }
}
