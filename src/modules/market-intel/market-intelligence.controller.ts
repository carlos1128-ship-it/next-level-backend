import { Body, Controller, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ActiveCompanyGuard } from '../../common/guards/active-company.guard';
import { MarketIntelligenceService } from './market-intelligence.service';
import { TrackMarketDto } from './dto/track-market.dto';

@Controller('market-intel')
@UseGuards(ActiveCompanyGuard)
export class MarketIntelligenceController {
  constructor(private readonly marketIntel: MarketIntelligenceService) {}

  @Get('overview')
  getOverview(
    @Req() req: { user: { id: string; companyId?: string | null } },
    @Query('companyId') companyId?: string,
  ) {
    return this.marketIntel.getOverview(req.user.id, companyId || req.user.companyId);
  }

  @Post('track')
  trackNow(
    @Req() req: { user: { id: string; companyId?: string | null } },
    @Body() body: TrackMarketDto,
    @Query('companyId') companyId?: string,
  ) {
    return this.marketIntel.trackNow(req.user.id, companyId || req.user.companyId, body.productIds);
  }

  @Post('trends/refresh')
  refreshTrends(
    @Req() req: { user: { id: string; companyId?: string | null } },
    @Query('companyId') companyId?: string,
  ) {
    return this.marketIntel.refreshTrends(req.user.id, companyId || req.user.companyId);
  }
}
