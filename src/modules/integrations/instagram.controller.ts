import {
  Body,
  Controller,
  Get,
  Headers,
  Logger,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { Public } from '../../common/decorators/public.decorator';
import { ActiveCompanyGuard } from '../../common/guards/active-company.guard';
import { RequirePlan } from '../billing/decorators/require-plan.decorator';
import { InstagramService } from './instagram.service';

type AuthenticatedRequest = Request & {
  user?: {
    id?: string;
    userId?: string;
    companyId?: string | null;
  };
  rawBody?: Buffer;
};

@Controller('instagram')
export class InstagramController {
  private readonly logger = new Logger(InstagramController.name);

  constructor(private readonly instagramService: InstagramService) {}

  @Get('connect')
  @UseGuards(ActiveCompanyGuard)
  @RequirePlan('PREMIUM')
  connect(
    @Req() req: AuthenticatedRequest,
    @Query('companyId') companyId: string,
    @Query('returnTo') returnTo?: string,
  ) {
    return this.instagramService.buildConnectUrl({
      companyId,
      userId: req.user?.id || req.user?.userId || null,
      returnTo,
    });
  }

  @Public()
  @Get('callback')
  async callback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Query('error') error: string | undefined,
    @Query('error_description') errorDescription: string | undefined,
    @Res() res: Response,
  ) {
    this.logger.log(
      JSON.stringify({
        event: 'instagram.oauth.callback_reached',
        callbackReached: true,
        hasCode: Boolean(code),
        hasError: Boolean(error),
        error: error || null,
      }),
    );

    if (error) {
      return res.redirect(
        302,
        this.buildIntegrationRedirect('error', errorDescription || error),
      );
    }

    try {
      const result = await this.instagramService.handleOAuthCallback(code, state);
      const message = result.subscription.success
          ? 'Instagram conectado com sucesso.'
          : 'Instagram conectado. A assinatura do webhook precisa ser revisada no Meta App.';

      return res.redirect(
        302,
        this.buildIntegrationRedirect('connected', message, result.returnTo),
      );
    } catch (callbackError) {
      const message =
        callbackError instanceof Error
          ? callbackError.message
          : 'Nao foi possivel concluir o OAuth do Instagram.';
      this.logger.warn(
        JSON.stringify({
          event: 'instagram.oauth.callback_failed',
          callbackReached: true,
          hasCode: Boolean(code),
          hasState: Boolean(state),
          hasError: Boolean(error),
          message,
        }),
      );

      return res.redirect(
        302,
        this.buildIntegrationRedirect('error', message),
      );
    }
  }

  @Get('status')
  @UseGuards(ActiveCompanyGuard)
  @RequirePlan('PREMIUM')
  status(@Query('companyId') companyId: string) {
    return this.instagramService.getStatus(companyId);
  }

  @Post('disconnect')
  @UseGuards(ActiveCompanyGuard)
  @RequirePlan('PREMIUM')
  disconnect(@Query('companyId') companyId: string) {
    return this.instagramService.disconnect(companyId);
  }

  @Public()
  @Get('debug/oauth-url')
  debugOAuthUrl(@Headers('authorization') authorization: string | undefined) {
    this.assertDebugAllowed(authorization);
    return this.instagramService.getOAuthDebugInfo();
  }

  @Public()
  @Post('debug/compare-oauth-url')
  compareOAuthUrl(
    @Body('metaEmbeddedUrl') metaEmbeddedUrl: string | undefined,
    @Headers('authorization') authorization: string | undefined,
  ) {
    this.assertDebugAllowed(authorization);
    return this.instagramService.compareOAuthUrl(
      metaEmbeddedUrl,
      authorization,
    );
  }

  private buildIntegrationRedirect(
    status: 'connected' | 'error',
    message: string,
    returnTo?: string,
  ) {
    const frontend = (process.env.FRONTEND_APP_URL || 'http://localhost:5173').replace(/\/+$/, '');
    const redirectUrl = new URL(returnTo || '/integrations', frontend);
    redirectUrl.searchParams.set('integration_provider', 'instagram');
    redirectUrl.searchParams.set('integration_status', status);
    redirectUrl.searchParams.set('integration_message', message);
    return redirectUrl.toString();
  }

  private assertDebugAllowed(authorization?: string) {
    if (process.env.NODE_ENV !== 'production') {
      return;
    }
    const expected =
      process.env.INTERNAL_AUTOMATION_TOKEN?.trim() ||
      process.env.WEBHOOK_SECRET?.trim();
    const provided = authorization?.replace(/^Bearer\s+/i, '').trim();
    if (!expected || provided !== expected) {
      throw new UnauthorizedException('Diagnostico protegido em producao');
    }
  }
}
