import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { InsightsService } from './insights.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CompanyGuard } from '../../common/guards/company.guard';
import { CompanyId } from '../../common/decorators/company-id.decorator';
import { PeriodQueryDto } from '../../common/dto/period-query.dto';

@Controller('insights')
@UseGuards(JwtAuthGuard, CompanyGuard)
export class InsightsController {
  constructor(private readonly insightsService: InsightsService) {}

  @Get()
  async getInsights(
    @CompanyId() companyId: string,
    @Query() query: PeriodQueryDto,
  ) {
    const { start, end } = query;
    const endDate = end ? new Date(end) : new Date();
    const startDate = start
      ? new Date(start)
      : new Date(new Date().setMonth(new Date().getMonth() - 1));
    return this.insightsService.getInsights(companyId, startDate, endDate);
  }
}
