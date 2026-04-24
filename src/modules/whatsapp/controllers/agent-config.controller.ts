import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ActiveCompanyGuard } from '../../../common/guards/active-company.guard';
import { UpdateAgentConfigDto } from '../dto/update-agent-config.dto';
import { WhatsappAgentConfigService } from '../services/whatsapp-agent-config.service';

@Controller('agent-config')
@UseGuards(ActiveCompanyGuard)
export class AgentConfigController {
  constructor(
    private readonly whatsappAgentConfigService: WhatsappAgentConfigService,
  ) {}

  @Get()
  getCurrentConfig(
    @Req() req: { user?: { companyId?: string | null } },
    @Query('companyId') companyId?: string,
  ) {
    return this.whatsappAgentConfigService.get(companyId || req.user?.companyId || '');
  }

  @Get(':companyId')
  getConfig(@Param('companyId') companyId: string) {
    return this.whatsappAgentConfigService.get(companyId);
  }

  @Post()
  createOrReplaceCurrentConfig(
    @Req() req: { user?: { companyId?: string | null } },
    @Body() dto: UpdateAgentConfigDto,
    @Query('companyId') companyId?: string,
  ) {
    return this.whatsappAgentConfigService.update(companyId || req.user?.companyId || '', dto);
  }

  @Post(':companyId')
  createOrReplaceConfig(
    @Param('companyId') companyId: string,
    @Body() dto: UpdateAgentConfigDto,
  ) {
    return this.whatsappAgentConfigService.update(companyId, dto);
  }

  @Patch()
  updateCurrentConfig(
    @Req() req: { user?: { companyId?: string | null } },
    @Body() dto: UpdateAgentConfigDto,
    @Query('companyId') companyId?: string,
  ) {
    return this.whatsappAgentConfigService.update(companyId || req.user?.companyId || '', dto);
  }

  @Patch(':companyId')
  updateConfig(
    @Param('companyId') companyId: string,
    @Body() dto: UpdateAgentConfigDto,
  ) {
    return this.whatsappAgentConfigService.update(companyId, dto);
  }
}
