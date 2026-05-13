import { Body, Controller, Get, Post, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { BillingService } from './billing.service';
import { BillingPlansService } from './billing-plans.service';
import { ChangePlanDto } from './dto/change-plan.dto';
import { CreateSubscriptionCheckoutDto } from './dto/create-subscription-checkout.dto';
import { SkipSubscriptionCheck } from './decorators/require-plan.decorator';

@Controller('billing')
export class BillingController {
  constructor(
    private readonly billingService: BillingService,
    private readonly billingPlansService: BillingPlansService,
  ) {}

  @Public()
  @Get('plans')
  getPlans() {
    return this.billingPlansService.listPlans();
  }

  @Public()
  @Get('config')
  getConfig() {
    return this.billingService.getBillingConfig();
  }

  @SkipSubscriptionCheck()
  @Get('me')
  getMe(
    @CurrentUser() user: { id?: string; userId?: string; sub?: string },
    @Query('companyId') companyId?: string,
  ) {
    return this.billingService.getBillingForUser(user.id || user.userId || user.sub || '', companyId);
  }

  @SkipSubscriptionCheck()
  @Post('checkout')
  createCheckout(
    @CurrentUser() user: Record<string, unknown>,
    @Body() dto: CreateSubscriptionCheckoutDto,
  ) {
    return this.billingService.createCheckout(user, dto);
  }

  @Public()
  @Post('webhooks/abacatepay')
  handleAbacatePayWebhook(@Req() request: Request) {
    return this.billingService.handleWebhook(request, 'ABACATEPAY');
  }

  @Public()
  @Post('webhooks/cakto')
  handleCaktoWebhook(@Req() request: Request) {
    return this.billingService.handleWebhook(request, 'CAKTO');
  }

  @Public()
  @Post('webhooks/cacto')
  handleCactoWebhook(@Req() request: Request) {
    return this.billingService.handleWebhook(request, 'CACTO');
  }

  @Post('cancel')
  cancel(@CurrentUser() user: Record<string, unknown>) {
    return this.billingService.cancelCurrentSubscription(user);
  }

  @Post('change-plan')
  changePlan(@CurrentUser() user: Record<string, unknown>, @Body() dto: ChangePlanDto) {
    return this.billingService.changePlan(user, dto);
  }
}
