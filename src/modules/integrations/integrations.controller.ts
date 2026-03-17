import {
  Body,
  Controller,
  Get,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { IntegrationProvider } from '@prisma/client';
import { ActiveCompanyGuard } from '../../common/guards/active-company.guard';
import { IntegrationsService } from './integrations.service';

interface ConnectIntegrationDto {
  provider: IntegrationProvider;
  accessToken: string;
  externalId: string;
  status?: string;
  companyId?: string | null;
}

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
