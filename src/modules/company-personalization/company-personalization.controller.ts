import { Body, Controller, Get, Post, Put, Query } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { JwtPayload } from '../../common/decorators/current-user.decorator';
import {
  CompanyPersonalizationService,
  type ModulePreferenceInput,
  type OnboardingPayload,
} from './company-personalization.service';
import type { PersonalizationProfileInput } from './business-personalization.registry';

@Controller('company')
export class CompanyPersonalizationController {
  constructor(
    private readonly personalizationService: CompanyPersonalizationService,
  ) {}

  @Get('personalization/status')
  getStatus(
    @CurrentUser() user: JwtPayload,
    @Query('companyId') companyId?: string,
  ) {
    return this.personalizationService.getStatus(user, companyId);
  }

  @Get('personalization')
  getPersonalization(
    @CurrentUser() user: JwtPayload,
    @Query('companyId') companyId?: string,
  ) {
    return this.personalizationService.getPersonalization(user, companyId);
  }

  @Post('personalization/onboarding')
  saveOnboarding(
    @CurrentUser() user: JwtPayload,
    @Body() payload: Record<string, unknown>,
    @Query('companyId') companyId?: string,
  ) {
    return this.personalizationService.saveOnboarding(
      user,
      payload as OnboardingPayload,
      companyId,
    );
  }

  @Post('personalization/preview')
  previewRecommendations(
    @CurrentUser() user: JwtPayload,
    @Body() payload: Record<string, unknown>,
    @Query('companyId') companyId?: string,
  ) {
    return this.personalizationService.previewRecommendations(
      user,
      payload as PersonalizationProfileInput,
      companyId,
    );
  }

  @Put('personalization/profile')
  updateProfile(
    @CurrentUser() user: JwtPayload,
    @Body() payload: Record<string, unknown>,
    @Query('companyId') companyId?: string,
  ) {
    return this.personalizationService.updateProfile(
      user,
      payload as PersonalizationProfileInput,
      companyId,
    );
  }

  @Post('personalization/reset-recommendations')
  resetRecommendations(
    @CurrentUser() user: JwtPayload,
    @Query('companyId') companyId?: string,
  ) {
    return this.personalizationService.resetRecommendations(user, companyId);
  }

  @Put('modules/preferences')
  saveModulePreferences(
    @CurrentUser() user: JwtPayload,
    @Body('preferences') preferences: unknown,
    @Query('companyId') companyId?: string,
  ) {
    return this.personalizationService.saveModulePreferences(
      user,
      (Array.isArray(preferences) ? preferences : []) as ModulePreferenceInput[],
      companyId,
    );
  }
}
