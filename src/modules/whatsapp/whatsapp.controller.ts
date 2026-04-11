import { Controller, Get, Post, Param, Body, Logger, Query } from '@nestjs/common';
import { WhatsappService } from './whatsapp.service';

@Controller('whatsapp/session')
export class WhatsappController {
  private readonly logger = new Logger(WhatsappController.name);

  constructor(private readonly whatsappService: WhatsappService) { }

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

  /**
   * Health check detalhado — usado pela aba "Atendente Virtual"
   * Retorna estado REAL da sessão, incluindo verificação live com o WPPConnect.
   */
  @Get(':companyId/health')
  async getHealth(@Param('companyId') companyId: string) {
    return this.whatsappService.getHealthStatus(companyId);
  }

  /**
   * Cleanup forçado — usado ao trocar de empresa no frontend.
   * Desconecta, limpa memória e arquivos de sessão.
   */
  @Post(':companyId/cleanup')
  async cleanup(@Param('companyId') companyId: string) {
    this.logger.log(`[HTTP][CLEANUP] Company: ${companyId}`);
    return this.whatsappService.forceCleanupSession(companyId);
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
