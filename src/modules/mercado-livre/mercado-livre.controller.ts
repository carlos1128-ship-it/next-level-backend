import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ActiveCompanyGuard } from '../../common/guards/active-company.guard';
import { PlanEntitlementsService } from '../billing/plan-entitlements.service';
import { MercadoLivreAuthService } from './mercado-livre-auth.service';
import { MercadoLivreSyncService } from './mercado-livre-sync.service';

@Controller('integrations/mercadolivre')
@UseGuards(ActiveCompanyGuard)
export class MercadoLivreController {
  constructor(
    private readonly authService: MercadoLivreAuthService,
    private readonly syncService: MercadoLivreSyncService,
    private readonly planEntitlements: PlanEntitlementsService,
  ) {}

  @Get('status')
  async status(@Query('companyId') companyId: string) {
    await this.assertAccess(companyId);
    return this.authService.getStatus(companyId);
  }

  @Get('dashboard')
  async dashboard(@Query('companyId') companyId: string) {
    await this.assertAccess(companyId);
    return this.syncService.getDashboard(companyId);
  }

  @Get('products')
  async products(@Query('companyId') companyId: string) {
    await this.assertAccess(companyId);
    return this.syncService.listProducts(companyId);
  }

  @Get('orders')
  async orders(@Query('companyId') companyId: string) {
    await this.assertAccess(companyId);
    return this.syncService.listOrders(companyId);
  }

  @Get('questions')
  async questions(@Query('companyId') companyId: string) {
    await this.assertAccess(companyId);
    return this.syncService.listQuestions(companyId);
  }

  @Get('reviews')
  async reviews(@Query('companyId') companyId: string) {
    await this.assertAccess(companyId);
    return this.syncService.listReviews(companyId);
  }

  @Get('sync-status')
  async syncStatus(@Query('companyId') companyId: string) {
    await this.assertAccess(companyId);
    const [status, dashboard] = await Promise.all([
      this.authService.getStatus(companyId),
      this.syncService.getDashboard(companyId),
    ]);
    return { ...status, dashboard };
  }

  @Post('sync')
  async sync(
    @CurrentUser('sub') userId: string,
    @Query('companyId') companyId: string,
  ) {
    await this.assertAccess(companyId);
    return this.syncService.syncAll(companyId, userId);
  }

  @Post('sync-now')
  syncNow(
    @CurrentUser('sub') userId: string,
    @Query('companyId') companyId: string,
  ) {
    return this.sync(userId, companyId);
  }

  @Post('sync/products')
  async syncProducts(@Query('companyId') companyId: string) {
    await this.assertAccess(companyId);
    return this.syncService.syncProducts(companyId).then((count) => ({ count }));
  }

  @Post('sync/orders')
  async syncOrders(
    @CurrentUser('sub') userId: string,
    @Query('companyId') companyId: string,
  ) {
    await this.assertAccess(companyId);
    return this.syncService.syncOrders(companyId, userId).then((count) => ({ count }));
  }

  @Post('sync/questions')
  async syncQuestions(@Query('companyId') companyId: string) {
    await this.assertAccess(companyId);
    return this.syncService.syncQuestions(companyId).then((count) => ({ count }));
  }

  @Post('questions/answer')
  async answerQuestion(
    @Query('companyId') companyId: string,
    @Body() body: { questionId?: string; text?: string },
  ) {
    await this.assertAccess(companyId);
    return this.syncService.answerQuestion(companyId, String(body.questionId || ''), String(body.text || ''));
  }

  @Post('disconnect')
  async disconnect(@Query('companyId') companyId: string) {
    await this.assertAccess(companyId);
    return this.authService.disconnect(companyId);
  }

  private assertAccess(companyId: string) {
    return this.planEntitlements.assertIntegrationAccessForCompany(companyId, 'MERCADOLIVRE');
  }
}
