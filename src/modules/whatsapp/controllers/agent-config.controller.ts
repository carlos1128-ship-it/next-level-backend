import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ActiveCompanyGuard } from '../../../common/guards/active-company.guard';
import { UpdateAgentConfigDto } from '../dto/update-agent-config.dto';
import { WhatsappAgentConfigService } from '../services/whatsapp-agent-config.service';

@Controller('agent-config')
@UseGuards(ActiveCompanyGuard)
export class AgentConfigController {
  constructor(
    private readonly whatsappAgentConfigService: WhatsappAgentConfigService,
  ) {}

  @Get(':companyId')
  getConfig(@Param('companyId') companyId: string) {
    return this.whatsappAgentConfigService.get(companyId);
  }

  @Post(':companyId')
  createOrReplaceConfig(
    @Param('companyId') companyId: string,
    @Body() dto: UpdateAgentConfigDto,
  ) {
    return this.whatsappAgentConfigService.update(companyId, dto);
  }

  @Patch(':companyId')
  updateConfig(
    @Param('companyId') companyId: string,
    @Body() dto: UpdateAgentConfigDto,
  ) {
    return this.whatsappAgentConfigService.update(companyId, dto);
  }
}
