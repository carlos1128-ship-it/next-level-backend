import {
  Body,
  Controller,
  Get,
  Patch,
  Post,
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
  ) {
    return this.whatsappAgentConfigService.get(req.user?.companyId || '');
  }

  @Post()
  createOrReplaceCurrentConfig(
    @Req() req: { user?: { companyId?: string | null } },
    @Body() dto: UpdateAgentConfigDto,
  ) {
    return this.whatsappAgentConfigService.update(req.user?.companyId || '', dto);
  }

  @Patch()
  updateCurrentConfig(
    @Req() req: { user?: { companyId?: string | null } },
    @Body() dto: UpdateAgentConfigDto,
  ) {
    return this.whatsappAgentConfigService.update(req.user?.companyId || '', dto);
  }
}
