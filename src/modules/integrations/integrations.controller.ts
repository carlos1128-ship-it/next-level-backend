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
import { ShopeeScraperService } from './shopee-scraper.service';
import { MetaIntegrationService } from '../meta/meta.service';
import { SaveMetaConfigDto } from '../meta/dto/save-meta-config.dto';

@Controller('integrations')
@UseGuards(ActiveCompanyGuard)
export class IntegrationsController {
  constructor(
    private readonly integrationsService: IntegrationsService,
    private readonly shopeeScraper: ShopeeScraperService,
    private readonly metaIntegrationService: MetaIntegrationService
  ) {}

  @Get('whatsapp/profile')
  async whatsappProfile(
    @Query('companyId') companyId: string,
  ) {
    const health = await this.metaIntegrationService.getHealthStatus(companyId);
    return { data: { name: 'WhatsApp Business API', connected: health.status === 'CONNECTED' } };
  }

  @Post('whatsapp/bulk-send')
  async whatsappBulkSend(
    @Query('companyId') companyId: string,
    @Body() body: { numbers: string[]; message: string }
  ) {
    return this.metaIntegrationService.sendBulkMessages({
      companyId,
      numbers: body.numbers,
      message: body.message,
    });
  }

  // saveMetaConfig moved to WhatsappConfigController in MetaIntegrationModule

  @Get('shopee/orders')
  async shopeeOrders(
    @Query('companyId') companyId: string,
  ) {
    const orders = await this.shopeeScraper.getRecentOrders(companyId);
    return { data: orders };
  }

  @Post('shopee/initialize-login')
  async shopeeInitLogin(
    @Query('companyId') companyId: string,
    @Body() credentials: { user?: string; pass?: string }
  ) {
    return this.shopeeScraper.initializeLogin(companyId, credentials);
  }

  @Post('shopee/verify-otp')
  async shopeeVerifyOtp(
    @Query('companyId') companyId: string,
    @Body('code') code: string,
  ) {
    return this.shopeeScraper.submitVerificationCode(companyId, code);
  }

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
