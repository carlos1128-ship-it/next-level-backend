import { Controller, Get, Post, Param, Body, Logger } from '@nestjs/common';
import { WhatsappService } from './whatsapp.service';

@Controller('whatsapp/session')
export class WhatsappController {
  private readonly logger = new Logger(WhatsappController.name);

  constructor(private readonly whatsappService: WhatsappService) {}

  @Post(':companyId/start')
  async start(@Param('companyId') companyId: string) {
    this.logger.log(`[HTTP][START] Company: ${companyId}`);
    return this.whatsappService.createSession(companyId);
  }

  @Get(':companyId/qrcode')
  async getQrCode(@Param('companyId') companyId: string) {
    const qr = this.whatsappService.getQrCode(companyId);
    const status = this.whatsappService.getStatus(companyId);
    return { 
      qrcode: qr || null, 
      status 
    };
  }

  @Get(':companyId/status')
  async getStatus(@Param('companyId') companyId: string) {
    const status = this.whatsappService.getStatus(companyId);
    return { status };
  }

  @Post(':companyId/disconnect')
  async disconnect(@Param('companyId') companyId: string) {
    this.logger.log(`[HTTP][DISCONNECT] Company: ${companyId}`);
    return this.whatsappService.terminateSession(companyId);
  }

  @Post('webhook')
  async webhook(@Body() body: any) {
    // Reservado para futuras integrações de Webhook (Postman/Z-API/Evolution)
    return { success: true };
  }
}
