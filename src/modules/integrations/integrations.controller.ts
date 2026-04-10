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
import { WhatsappService } from './whatsapp.service';

@Controller('integrations')
@UseGuards(ActiveCompanyGuard)
export class IntegrationsController {
  constructor(
    private readonly integrationsService: IntegrationsService,
    private readonly shopeeScraper: ShopeeScraperService,
    private readonly whatsappService: WhatsappService
  ) {}

  @Get('whatsapp/profile')
  async whatsappProfile(
    @Query('companyId') companyId: string,
  ) {
    // Smart Reconciliation: Check live status and sync DB if needed before returning profile
    await this.whatsappService.checkLiveStatus(companyId).catch(() => null);
    
    const profile = await this.whatsappService.getProfile(companyId);
    return { data: profile };
  }

  @Post('whatsapp/bulk-send')
  async whatsappBulkSend(
    @Query('companyId') companyId: string,
    @Body() body: { numbers: string[]; message: string }
  ) {
    return this.whatsappService.sendBulkMessages({
      companyId,
      numbers: body.numbers,
      message: body.message,
    });
  }

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
