import { BadRequestException, Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common';
import { AnalyticsService, ProfitRow } from './analytics.service';
import { ActiveCompanyGuard } from '../../common/guards/active-company.guard';
import { ForecastService } from './forecast.service';
import { ForecastType } from '@prisma/client';

@Controller('analytics')
@UseGuards(ActiveCompanyGuard)
export class AnalyticsController {
  constructor(
    private readonly analyticsService: AnalyticsService,
    private readonly forecastService: ForecastService,
  ) {}

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

  @Get('forecast/:type')
  forecast(
    @Param('type') type: string,
    @Req() req: { user: { id: string; companyId?: string | null } },
    @Query('companyId') companyId?: string,
    @Query('horizon') horizon?: string,
  ) {
    const normalizedType = String(type || '').toUpperCase() as ForecastType;
    const allowedTypes = Object.values(ForecastType);

    if (!allowedTypes.includes(normalizedType)) {
      throw new BadRequestException('Tipo de forecast invalido');
    }

    const resolvedCompanyId = companyId ?? req.user.companyId ?? undefined;
    const horizonDays = Math.min(30, Math.max(1, Number(horizon) || 30));
    return this.forecastService.getForecast(
      req.user.id,
      normalizedType,
      resolvedCompanyId,
      horizonDays,
    );
  }
}
