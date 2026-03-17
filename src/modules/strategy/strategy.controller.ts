import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ActiveCompanyGuard } from '../../common/guards/active-company.guard';
import { StrategyService } from './strategy.service';
import { StrategicActionStatus } from '@prisma/client';

@Controller('strategy')
@UseGuards(ActiveCompanyGuard)
export class StrategyController {
  constructor(private readonly strategyService: StrategyService) {}

  @Get('actions')
  list(
    @Req() req: { user: { id: string; companyId?: string | null } },
    @Query('status') status?: StrategicActionStatus,
    @Query('companyId') companyId?: string,
  ) {
    const normalizedStatus =
      status && Object.values(StrategicActionStatus).includes(status)
        ? status
        : StrategicActionStatus.SUGGESTED;
    return this.strategyService.listActions(
      req.user.id,
      normalizedStatus,
      companyId || req.user.companyId,
    );
  }

  @Post('actions/:id/execute')
  execute(
    @Param('id') id: string,
    @Req() req: { user: { id: string; companyId?: string | null } },
    @Query('companyId') companyId?: string,
  ) {
    return this.strategyService.approveAndExecute(
      req.user.id,
      id,
      companyId || req.user.companyId,
    );
  }

  @Post('actions/suggest-revenue')
  suggestRevenue(
    @Req() req: { user: { id: string; companyId?: string | null } },
    @Body() body: { dropPercent: number; companyId?: string },
  ) {
    const drop = Number(body.dropPercent || 0);
    return this.strategyService.suggestRevenueRecoveryPlan(
      body.companyId || req.user.companyId || '',
      drop > 0 ? drop : 20,
    );
  }
}
