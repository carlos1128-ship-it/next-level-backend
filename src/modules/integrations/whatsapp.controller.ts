import { Controller, Get, Post, Param, Body, UseGuards, BadRequestException } from '@nestjs/common';
import { WhatsappService } from './whatsapp.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Logger } from '@nestjs/common';

@Controller('whatsapp/session')
export class WhatsappController {
  private readonly logger = new Logger(WhatsappController.name);

  constructor(private readonly whatsappService: WhatsappService) {}

  @Post(':companyId/start')
  async start(@Param('companyId') companyId: string) {
    this.logger.log(`[HTTP][START] Company: ${companyId}`);
    return this.whatsappService.startSession(companyId);
  }

  @Get(':companyId/qrcode')
  async getQrCode(@Param('companyId') companyId: string) {
    const qr = this.whatsappService.getQrCode(companyId);
    if (!qr) return { qrcode: null, status: this.whatsappService.getSessionStatus(companyId) };
    return { qrcode: qr, status: 'WAITING_SCAN' };
  }

  @Get(':companyId/status')
  async getStatus(@Param('companyId') companyId: string) {
    const status = this.whatsappService.getSessionStatus(companyId);
    return { status };
  }

  @Post(':companyId/disconnect')
  async disconnect(@Param('companyId') companyId: string) {
    this.logger.log(`[HTTP][DISCONNECT] Company: ${companyId}`);
    return this.whatsappService.disconnect(companyId);
  }

  @Post('webhook')
  async webhook(@Body() body: any) {
    // Implementação de webhook externo se necessário (ex: integrando com APIs oficiais)
    // Para WPPConnect legacy, o próprio listener no service lida com isso.
    return { success: true };
  }
}
