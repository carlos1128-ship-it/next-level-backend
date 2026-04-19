import {
  Body,
  Controller,
  Delete,
  Get,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { Public } from '../../common/decorators/public.decorator';
import { ActiveCompanyGuard } from '../../common/guards/active-company.guard';
import { EvolutionService } from './evolution.service';

type AuthenticatedRequest = Request & {
  user?: {
    companyId?: string | null;
  };
};

@Controller('evolution')
export class EvolutionController {
  constructor(private readonly evolutionService: EvolutionService) {}

  @Public()
  @Post('webhook')
  async receiveWebhook(@Body() payload: Record<string, unknown>) {
    await this.evolutionService.processWebhook(payload);
    return { status: 'ok' };
  }

  @Post('connect')
  @UseGuards(ActiveCompanyGuard)
  async connect(
    @Req() req: AuthenticatedRequest,
    @Body('companyId') companyId?: string,
  ) {
    const resolvedCompanyId = companyId || req.user?.companyId || '';
    await this.evolutionService.createInstance(resolvedCompanyId);
    return {
      status: 'connecting',
      message: 'Gerando QR Code... aguarde alguns segundos.',
    };
  }

  @Get('qrcode')
  @UseGuards(ActiveCompanyGuard)
  async getQRCode(
    @Req() req: AuthenticatedRequest,
    @Query('companyId') companyId?: string,
  ) {
    const resolvedCompanyId = companyId || req.user?.companyId || '';
    const qrcode = await this.evolutionService.getQRCode(resolvedCompanyId);
    return {
      qrcode,
      qrCode: qrcode,
      ready: Boolean(qrcode),
    };
  }

  @Get('status')
  @UseGuards(ActiveCompanyGuard)
  async getStatus(
    @Req() req: AuthenticatedRequest,
    @Query('companyId') companyId?: string,
  ) {
    const resolvedCompanyId = companyId || req.user?.companyId || '';
    const state = await this.evolutionService.getConnectionStatus(resolvedCompanyId);
    return {
      connected: state === 'open',
      state,
    };
  }

  @Delete('disconnect')
  @UseGuards(ActiveCompanyGuard)
  async disconnect(
    @Req() req: AuthenticatedRequest,
    @Body('companyId') companyId?: string,
  ) {
    const resolvedCompanyId = companyId || req.user?.companyId || '';
    await this.evolutionService.disconnectInstance(resolvedCompanyId);
    return { status: 'disconnected' };
  }
}
