import { Controller, Get, Logger, Query, Req, Res, UseGuards } from '@nestjs/common';
import { Request, Response } from 'express';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { ActiveCompanyGuard } from '../../common/guards/active-company.guard';
import { MercadoLivreAuthService } from './mercado-livre-auth.service';
import { MercadoLivreSyncService } from './mercado-livre-sync.service';

@Controller('auth/ml')
export class MercadoLivreAuthController {
  private readonly logger = new Logger(MercadoLivreAuthController.name);

  constructor(
    private readonly authService: MercadoLivreAuthService,
    private readonly syncService: MercadoLivreSyncService,
  ) {}

  @Get()
  @UseGuards(ActiveCompanyGuard)
  beginOAuth(
    @CurrentUser('sub') userId: string,
    @Query('companyId') companyId: string,
    @Query('returnTo') returnTo: string | undefined,
    @Req() req: Request,
  ) {
    return this.authService.beginOAuth({ userId, companyId, returnTo, req });
  }

  @Public()
  @Get('callback')
  async callback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Query('error_description') errorDescription: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const result = await this.authService.handleCallback({
      code,
      state,
      error,
      errorDescription,
      req,
    });
    if (result.connected && result.companyId) {
      setImmediate(() => {
        this.logger.log(
          JSON.stringify({
            event: 'mercado_livre.initial_sync.started',
            companyId: result.companyId,
          }),
        );
        this.syncService.syncAll(result.companyId, result.userId).catch((syncError) => {
          this.logger.error(
            `Falha no sync inicial Mercado Livre: ${syncError instanceof Error ? syncError.message : syncError}`,
          );
        });
      });
    }
    return res.redirect(302, result.redirectUrl);
  }
}
