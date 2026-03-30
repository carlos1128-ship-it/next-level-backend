import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ActiveCompanyGuard } from '../../common/guards/active-company.guard';
import { ConnectIntegrationDto } from './dto/connect-integration.dto';
import { IntegrationsService } from './integrations.service';

@Controller('integrations')
@UseGuards(ActiveCompanyGuard)
export class IntegrationsController {
  constructor(private readonly integrationsService: IntegrationsService) {}

  @Get('status')
  async status(
    @Req() req: { user: { id: string } },
    @Query('companyId') companyId?: string,
  ) {
    const statuses = await this.integrationsService.listStatuses(
      req.user.id,
      companyId,
    );

    return { data: statuses };
  }

  @Get('status/:provider')
  async diagnostic(
    @Req() req: { user: { id: string } },
    @Param('provider') provider: string,
    @Query('companyId') companyId?: string,
  ) {
    return this.integrationsService.getProviderDiagnostic(
      req.user.id,
      provider,
      companyId,
    );
  }

  @Post('connect')
  async connect(
    @Req() req: { user: { id: string } },
    @Body() body: ConnectIntegrationDto,
    @Query('companyId') companyId?: string,
  ) {
    const integration = await this.integrationsService.upsertIntegration(
      req.user.id,
      body,
      body.companyId || companyId,
    );
    return this.integrationsService.sanitize(integration);
  }
}
