import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { ActiveCompanyGuard } from '../../../common/guards/active-company.guard';
import { WhatsappConversationsService } from '../services/whatsapp-conversations.service';

type AuthenticatedRequest = {
  user?: {
    companyId?: string | null;
  };
};

@Controller('conversations')
@UseGuards(ActiveCompanyGuard)
export class WhatsappConversationsController {
  constructor(
    private readonly whatsappConversationsService: WhatsappConversationsService,
  ) {}

  @Get('live-feed')
  getLiveFeed(
    @Req() req: AuthenticatedRequest,
    @Query('companyId') companyId?: string,
    @Query('limit') limit?: string,
  ) {
    return this.whatsappConversationsService.liveFeed(
      companyId || req.user?.companyId || '',
      Number(limit) || 30,
    );
  }
}
