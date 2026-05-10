import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { ActiveCompanyGuard } from '../../common/guards/active-company.guard';
import { RequirePlan } from '../billing/decorators/require-plan.decorator';
import { MetaOAuthService } from './meta-oauth.service';

@Controller('meta/oauth')
export class MetaOAuthController {
  constructor(private metaOAuthService: MetaOAuthService) {}

  // Endpoint called by frontend to get the Facebook OAuth URL
  @Get('url')
  @UseGuards(ActiveCompanyGuard)
  @RequirePlan('PREMIUM')
  getOAuthUrl(@Query('companyId') companyId: string) {
    const url = this.metaOAuthService.getOAuthUrl(companyId);
    console.log('[MetaOAuthController] Sending URL to frontend:', url);
    return { url };
  }

  // Callback endpoint — Meta redirects here after client authorizes
  @Get('callback')
  async handleCallback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Res() res: Response,
  ) {
    try {
      const { companyId } = this.metaOAuthService.validateOAuthState(state);
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
