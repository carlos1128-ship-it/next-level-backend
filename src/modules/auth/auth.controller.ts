import {
  Controller,
  Post,
  Body,
  HttpCode,
  HttpStatus,
  UseGuards,
  Get,
  Req,
  Res,
  Logger,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { Public } from '../../common/decorators/public.decorator';
import { RegisterDto } from './dto/register.dto';
import { Request, Response } from 'express';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(
    private readonly authService: AuthService,
    private readonly configService: ConfigService,
  ) {}

  @Public()
  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  async register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(@Body() body: { refresh_token?: string; refreshToken?: string }) {
    const refreshToken = body.refresh_token || body.refreshToken || '';
    return this.authService.refresh(refreshToken);
  }

  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(
    @CurrentUser('sub') userId: string | undefined,
    @Body() body: { refresh_token?: string; refreshToken?: string },
  ) {
    const refreshToken = body.refresh_token || body.refreshToken || '';
    return this.authService.logout(userId, refreshToken);
  }

  @UseGuards(AuthGuard('jwt'))
  @Get('me')
  getProfile(@Req() req: Request) {
    return req.user;
  }

  /* ─── Google OAuth ─── */

  @Public()
  @UseGuards(AuthGuard('google'))
  @Get('google')
  googleAuth() {
    // Guard redirects to Google consent screen
  }

  @Public()
  @UseGuards(AuthGuard('google'))
  @Get('google/callback')
  async googleCallback(@Req() req: Request, @Res() res: Response) {
    try {
      const googleUser = req.user as {
        googleId: string;
        email: string;
        name: string;
        avatar?: string;
      };

      const result = await this.authService.validateGoogleUser(googleUser);

      const frontendUrl =
        this.configService.get<string>('FRONTEND_APP_URL') || 'http://localhost:5173';

      const params = new URLSearchParams({
        token: result.access_token,
        ...(result.refresh_token ? { refresh_token: result.refresh_token } : {}),
        name: result.user.name || '',
        email: result.user.email,
        admin: String(result.user.admin),
      });

      res.redirect(`${frontendUrl}/auth/callback?${params.toString()}`);
    } catch (error) {
      this.logger.error('Google OAuth callback error', error);
      const frontendUrl =
        this.configService.get<string>('FRONTEND_APP_URL') || 'http://localhost:5173';
      res.redirect(`${frontendUrl}/login?error=google_auth_failed`);
    }
  }
}
