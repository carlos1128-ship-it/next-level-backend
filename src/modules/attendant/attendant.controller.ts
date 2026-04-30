import { Body, Controller, Get, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { ActiveCompanyGuard } from '../../common/guards/active-company.guard';
import { AttendantService } from './attendant.service';
import { UpdateBotConfigDto } from './dto/update-bot-config.dto';

@Controller('attendant')
@UseGuards(ActiveCompanyGuard)
export class AttendantController {
  constructor(private readonly attendantService: AttendantService) {}

  @Get('config')
  getConfig(@Req() req: { user: { companyId?: string | null } }) {
    return this.attendantService.getBotConfig(req.user.companyId!);
  }

  @Put('config')
  updateConfig(
    @Req() req: { user: { companyId?: string | null } },
    @Body() body: UpdateBotConfigDto,
  ) {
    return this.attendantService.updateBotConfig(req.user.companyId!, body);
  }

  @Get('leads')
  listLeads(
    @Req() req: { user: { companyId?: string | null } },
    @Query('companyId') companyId?: string,
    @Query('limit') limit?: string,
  ) {
    const resolved = companyId || req.user.companyId;
    const take = Math.min(50, Math.max(1, Number(limit) || 20));
    return this.attendantService.listLeads(resolved!, take);
  }

  @Post('leads/:id/intervene')
  intervene(
    @Param('id') id: string,
    @Req() req: { user: { companyId?: string | null } },
    @Query('companyId') companyId?: string,
  ) {
    const resolved = companyId || req.user.companyId;
    return this.attendantService.interveneLead(id, resolved!);
  }

  @Get('conversations')
  listConversations(
    @Req() req: { user: { companyId?: string | null } },
    @Query('companyId') companyId?: string,
    @Query('limit') limit?: string,
  ) {
    const resolved = companyId || req.user.companyId;
    const take = Math.min(50, Math.max(1, Number(limit) || 20));
    return this.attendantService.listConversationFeed(resolved!, take);
  }

  @Get('conversations/:id')
  getConversation(
    @Param('id') id: string,
    @Req() req: { user: { companyId?: string | null } },
    @Query('companyId') companyId?: string,
  ) {
    const resolved = companyId || req.user.companyId;
    return this.attendantService.getConversationThread(resolved!, id);
  }

  @Post('conversations/:id/pause')
  pauseConversation(
    @Param('id') id: string,
    @Req() req: { user: { companyId?: string | null } },
    @Query('companyId') companyId?: string,
  ) {
    const resolved = companyId || req.user.companyId;
    return this.attendantService.pauseConversation(id, resolved!);
  }

  @Post('conversations/:id/resume')
  resumeConversation(
    @Param('id') id: string,
    @Req() req: { user: { companyId?: string | null } },
    @Query('companyId') companyId?: string,
  ) {
    const resolved = companyId || req.user.companyId;
    return this.attendantService.resumeConversation(id, resolved!);
  }

  @Post('conversations/:id/human-message')
  sendHumanMessage(
    @Param('id') id: string,
    @Body() body: { content?: string },
    @Req() req: { user: { companyId?: string | null } },
    @Query('companyId') companyId?: string,
  ) {
    const resolved = companyId || req.user.companyId;
    return this.attendantService.sendHumanMessage(resolved!, id, body.content || '');
  }

  @Get('roi')
  roi(
    @Req() req: { user: { companyId?: string | null } },
    @Query('companyId') companyId?: string,
  ) {
    const resolved = companyId || req.user.companyId;
    return this.attendantService.getRoi(resolved!);
  }

  @Get('connection-status')
  getConnectionStatus(
    @Req() req: { user: { companyId?: string | null } },
    @Query('companyId') companyId?: string,
  ) {
    const resolved = companyId || req.user.companyId;
    return this.attendantService.getConnectionStatus(resolved!);
  }
}
