import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { ActiveCompanyGuard } from '../../common/guards/active-company.guard';
import { AIUsageService } from './ai-usage.service';

type UsageRequest = {
  user?: {
    companyId?: string | null;
    admin?: boolean;
  };
};

@Controller('usage/ai')
@UseGuards(ActiveCompanyGuard)
export class AIUsageController {
  constructor(private readonly aiUsageService: AIUsageService) {}

  @Get('current')
  getCurrentUsage(
    @Req() req: UsageRequest,
    @Query('yearMonth') yearMonth?: string,
  ) {
    return this.aiUsageService.getMonthlyUsage(
      req.user?.companyId || '',
      yearMonth,
    );
  }

  @Get('limits')
  getLimits(@Req() req: UsageRequest) {
    return this.aiUsageService.getPlanLimits(req.user?.companyId || '');
  }

  @Get('logs')
  getLogs(
    @Req() req: UsageRequest,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.aiUsageService.getLogs(
      req.user?.companyId || '',
      Number(page) || 1,
      Number(limit) || 25,
    );
  }
}
