import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
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
  async receiveWebhook(
    @Body() payload: Record<string, unknown>,
    @Query('token') token?: string,
    @Headers('x-evolution-token') headerToken?: string,
  ) {
    await this.evolutionService.processWebhook(payload, token || headerToken);
    return { status: 'ok' };
  }

  @Post('connect')
  @UseGuards(ActiveCompanyGuard)
  async connect(
    @Req() req: AuthenticatedRequest,
    @Body('companyId') companyId?: string,
  ) {
    const resolvedCompanyId = companyId || req.user?.companyId || '';
    return this.evolutionService.connectInstance(resolvedCompanyId);
  }

  @Get('qrcode')
  @UseGuards(ActiveCompanyGuard)
  async getQRCode(
    @Req() req: AuthenticatedRequest,
    @Query('companyId') companyId?: string,
  ) {
    const resolvedCompanyId = companyId || req.user?.companyId || '';
    return this.evolutionService.getQRCode(resolvedCompanyId);
  }

  @Get('status')
  @UseGuards(ActiveCompanyGuard)
  async getStatus(
    @Req() req: AuthenticatedRequest,
    @Query('companyId') companyId?: string,
  ) {
    const resolvedCompanyId = companyId || req.user?.companyId || '';
    return this.evolutionService.getConnectionSnapshot(resolvedCompanyId);
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
