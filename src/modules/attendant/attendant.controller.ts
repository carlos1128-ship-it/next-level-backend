import { Body, Controller, Get, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { ActiveCompanyGuard } from '../../common/guards/active-company.guard';
import { AttendantService } from './attendant.service';
import { UpdateBotConfigDto } from './dto/update-bot-config.dto';

@Controller('attendant')
@UseGuards(ActiveCompanyGuard)
export class AttendantController {
  constructor(private readonly attendantService: AttendantService) {}

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
    return this.attendantService.createWhatsappInstance(resolved!);
  }

  @Get('whatsapp/qrcode')
  getWhatsappQRCode(
    @Req() req: { user: { companyId?: string | null } },
    @Query('companyId') companyId?: string,
  ) {
    const resolved = companyId || req.user.companyId;
    return this.attendantService.getWhatsappQRCode(resolved!);
  }

  @Get('whatsapp/status')
  getWhatsappStatus(
    @Req() req: { user: { companyId?: string | null } },
    @Query('companyId') companyId?: string,
  ) {
    const resolved = companyId || req.user.companyId;
    return this.attendantService.getWhatsappStatus(resolved!);
  }
}
