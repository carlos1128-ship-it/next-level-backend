import { Body, Controller, Delete, Get, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { ActiveCompanyGuard } from '../../common/guards/active-company.guard';
import { AttendantService } from './attendant.service';
import { UpdateBotConfigDto } from './dto/update-bot-config.dto';

@Controller('attendant')
@UseGuards(ActiveCompanyGuard)
export class AttendantController {
  constructor(private readonly attendantService: AttendantService) { }

  @Get('config')
  getConfig(@Req() req: { user: { companyId?: string | null } }, @Query('companyId') companyId?: string) {
    const resolved = companyId || req.user.companyId;
    return this.attendantService.getBotConfig(resolved!);
  }

  @Put('config')
  updateConfig(
    @Req() req: { user: { companyId?: string | null } },
    @Body() body: UpdateBotConfigDto,
    @Query('companyId') companyId?: string,
  ) {
    const resolved = companyId || req.user.companyId;
    return this.attendantService.updateBotConfig(resolved!, body);
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

  @Post('whatsapp/instance')
  createWhatsappInstance(
    @Req() req: { user: { companyId?: string | null } },
    @Query('companyId') companyId?: string,
  ) {
    const resolved = companyId || req.user.companyId;
    return this.attendantService.createWhatsappSession(resolved!);
  }

  @Get('whatsapp/qrcode')
  getWhatsappQrCode(
    @Req() req: { user: { companyId?: string | null } },
    @Query('companyId') companyId?: string,
  ) {
    const resolved = companyId || req.user.companyId;
    return this.attendantService.getWhatsappQrCode(resolved!);
  }

  @Get('whatsapp/status')
  getWhatsappStatus(
    @Req() req: { user: { companyId?: string | null } },
    @Query('companyId') companyId?: string,
  ) {
    const resolved = companyId || req.user.companyId;
    return this.attendantService.getWhatsappStatus(resolved!);
  }

  /**
   * Health check detalhado — usado pela aba Atendente Virtual
   * para verificar estado REAL da conexão WhatsApp.
   */
  @Get('whatsapp/health')
  getWhatsappHealth(
    @Req() req: { user: { companyId?: string | null } },
    @Query('companyId') companyId?: string,
  ) {
    const resolved = companyId || req.user.companyId;
    return this.attendantService.getWhatsappHealth(resolved!);
  }

  /**
   * Cleanup forçado ao trocar de empresa.
   */
  @Post('whatsapp/cleanup')
  cleanupWhatsappSession(
    @Req() req: { user: { companyId?: string | null } },
    @Query('companyId') companyId?: string,
  ) {
    const resolved = companyId || req.user.companyId;
    return this.attendantService.cleanupWhatsappSession(resolved!);
  }

  @Delete('whatsapp/session/:companyId')
  terminateWhatsappSession(
    @Param('companyId') companyId: string,
  ) {
    return this.attendantService.terminateWhatsappSession(companyId);
  }

}
