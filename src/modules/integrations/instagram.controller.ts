import {
  Controller,
  Get,
  Logger,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { Public } from '../../common/decorators/public.decorator';
import { ActiveCompanyGuard } from '../../common/guards/active-company.guard';
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
          hasCode: Boolean(code),
          hasState: Boolean(state),
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
  status(@Query('companyId') companyId: string) {
    return this.instagramService.getStatus(companyId);
  }

  @Post('disconnect')
  @UseGuards(ActiveCompanyGuard)
  disconnect(@Query('companyId') companyId: string) {
    return this.instagramService.disconnect(companyId);
  }

  @Public()
  @Get('debug/oauth-url')
  debugOAuthUrl() {
    return this.instagramService.getOAuthDebugInfo();
  }

  @Public()
  @Get('webhook')
  verifyWebhook(
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const mode = this.readQueryValue(req.query['hub.mode']);
    const verifyToken = this.readQueryValue(req.query['hub.verify_token']);
    const challenge = this.readQueryValue(req.query['hub.challenge']);
    const challengeText = this.instagramService.verifyWebhookChallenge({
      mode,
      verifyToken,
      challenge,
    });

    this.logger.log(
      JSON.stringify({
        event: 'instagram.webhook.verify.response',
        contentType: 'text/plain',
        returnedChallenge: Boolean(challengeText),
      }),
    );

    return res.status(200).type('text/plain').send(challengeText);
  }

  @Public()
  @Post('webhook')
  webhook(@Req() req: AuthenticatedRequest) {
    return this.instagramService.processWebhook(
      req.body as Record<string, unknown>,
      req,
    );
  }

  private readQueryValue(value: unknown) {
    if (Array.isArray(value)) {
      const first = value.find((item) => typeof item === 'string' && item.trim());
      return typeof first === 'string' ? first.trim() : undefined;
    }

    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
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
}
