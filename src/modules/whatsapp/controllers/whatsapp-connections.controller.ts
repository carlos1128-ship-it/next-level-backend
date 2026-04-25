import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Public } from '../../../common/decorators/public.decorator';
import { ActiveCompanyGuard } from '../../../common/guards/active-company.guard';
import { ConnectWhatsappDto } from '../dto/connect-whatsapp.dto';
import { WhatsappConnectionsService } from '../services/whatsapp-connections.service';

type AuthenticatedRequest = {
  user?: {
    companyId?: string | null;
  };
};

@Controller('whatsapp')
export class WhatsappConnectionsController {
  constructor(
    private readonly whatsappConnectionsService: WhatsappConnectionsService,
  ) {}

  @Get('connection')
  @UseGuards(ActiveCompanyGuard)
  getConnection(
    @Req() req: AuthenticatedRequest,
    @Query('companyId') companyId?: string,
  ) {
    return this.whatsappConnectionsService.getCurrent(
      companyId || req.user?.companyId || '',
    );
  }

  @Get('connection/status')
  @UseGuards(ActiveCompanyGuard)
  getConnectionStatusByConnectionRoute(
    @Req() req: AuthenticatedRequest,
    @Query('companyId') companyId?: string,
  ) {
    return this.whatsappConnectionsService.getCurrent(
      companyId || req.user?.companyId || '',
    );
  }

  @Post('connect/start')
  @UseGuards(ActiveCompanyGuard)
  startConnection(
    @Req() req: AuthenticatedRequest,
    @Body() dto: ConnectWhatsappDto,
    @Query('companyId') companyId?: string,
  ) {
    return this.whatsappConnectionsService.connect(
      companyId || req.user?.companyId || '',
      dto,
    );
  }

  @Get('connect/status/:companyId')
  @UseGuards(ActiveCompanyGuard)
  getConnectionStatus(@Param('companyId') companyId: string) {
    return this.whatsappConnectionsService.getCurrent(companyId);
  }

  @Get('connect/status')
  @UseGuards(ActiveCompanyGuard)
  getCurrentConnectionStatus(
    @Req() req: AuthenticatedRequest,
    @Query('companyId') companyId?: string,
  ) {
    return this.whatsappConnectionsService.getCurrent(
      companyId || req.user?.companyId || '',
    );
  }

  @Post('connection/connect')
  @UseGuards(ActiveCompanyGuard)
  connect(
    @Req() req: AuthenticatedRequest,
    @Body() dto: ConnectWhatsappDto,
    @Query('companyId') companyId?: string,
  ) {
    return this.whatsappConnectionsService.connect(
      companyId || req.user?.companyId || '',
      dto,
    );
  }

  @Post('connection/refresh-qr')
  @UseGuards(ActiveCompanyGuard)
  refreshQr(
    @Req() req: AuthenticatedRequest,
    @Query('companyId') companyId?: string,
  ) {
    return this.whatsappConnectionsService.refreshQr(
      companyId || req.user?.companyId || '',
    );
  }

  @Post('connect/qr')
  @UseGuards(ActiveCompanyGuard)
  requestQr(
    @Req() req: AuthenticatedRequest,
    @Body('companyId') bodyCompanyId?: string,
    @Query('companyId') queryCompanyId?: string,
  ) {
    return this.whatsappConnectionsService.requestQr(
      bodyCompanyId || queryCompanyId || req.user?.companyId || '',
    );
  }

  @Post('connect/restart')
  @UseGuards(ActiveCompanyGuard)
  restartConnection(
    @Req() req: AuthenticatedRequest,
    @Body('companyId') bodyCompanyId?: string,
    @Query('companyId') queryCompanyId?: string,
  ) {
    return this.whatsappConnectionsService.restart(
      bodyCompanyId || queryCompanyId || req.user?.companyId || '',
    );
  }

  @Delete('connection')
  @UseGuards(ActiveCompanyGuard)
  disconnect(
    @Req() req: AuthenticatedRequest,
    @Query('companyId') companyId?: string,
  ) {
    return this.whatsappConnectionsService.disconnect(
      companyId || req.user?.companyId || '',
    );
  }

  @Post('connect/disconnect')
  @UseGuards(ActiveCompanyGuard)
  disconnectByPost(
    @Req() req: AuthenticatedRequest,
    @Body('companyId') bodyCompanyId?: string,
    @Query('companyId') queryCompanyId?: string,
  ) {
    return this.whatsappConnectionsService.disconnect(
      bodyCompanyId || queryCompanyId || req.user?.companyId || '',
    );
  }

  @Public()
  @Post('webhooks/evolution')
  async receiveEvolutionWebhook(
    @Body() payload: Record<string, unknown>,
    @Query('token') token?: string,
    @Query('instance') instanceName?: string,
    @Headers('x-provider-token') headerToken?: string,
  ) {
    await this.whatsappConnectionsService.handleEvolutionWebhook(
      {
        ...payload,
        instance: payload.instance || instanceName,
      },
      token || headerToken,
    );
    return { status: 'ok' };
  }

  @Public()
  @Post('webhooks/evolution/:eventName')
  async receiveEvolutionWebhookByEvent(
    @Param('eventName') eventName: string,
    @Body() payload: Record<string, unknown>,
    @Query('token') token?: string,
    @Query('instance') instanceName?: string,
    @Headers('x-provider-token') headerToken?: string,
  ) {
    await this.whatsappConnectionsService.handleEvolutionWebhook(
      {
        ...payload,
        event: payload.event || eventName,
        instance: payload.instance || instanceName,
      },
      token || headerToken,
    );
    return { status: 'ok' };
  }
}
