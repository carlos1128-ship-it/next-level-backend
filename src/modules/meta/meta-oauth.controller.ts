import { Controller, Get, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import { MetaOAuthService } from './meta-oauth.service';

@Controller('meta/oauth')
export class MetaOAuthController {
  constructor(private metaOAuthService: MetaOAuthService) {}

  // Endpoint called by frontend to get the Facebook OAuth URL
  @Get('url')
  getOAuthUrl(@Query('companyId') companyId: string) {
    const url = this.metaOAuthService.getOAuthUrl(companyId);
    console.log('[MetaOAuthController] Sending URL to frontend:', url);
    return { url };
  }

  // Callback endpoint — Meta redirects here after client authorizes
  @Get('callback')
  async handleCallback(
    @Query('code') code: string,
    @Query('state') companyId: string,
    @Res() res: Response,
  ) {
    try {
      await this.metaOAuthService.saveOAuthConnection(companyId, code);
      // Redirect back to frontend with success
      return res.redirect(
        `${process.env.FRONTEND_URL}/integrations?whatsapp=connected`
      );
    } catch (error) {
      console.error('Meta OAuth error:', error);
      return res.redirect(
        `${process.env.FRONTEND_URL}/integrations?whatsapp=error`
      );
    }
  }
}
