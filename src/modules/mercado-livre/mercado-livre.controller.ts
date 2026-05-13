import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ActiveCompanyGuard } from '../../common/guards/active-company.guard';
import { MercadoLivreAuthService } from './mercado-livre-auth.service';
import { MercadoLivreSyncService } from './mercado-livre-sync.service';

@Controller('integrations/mercadolivre')
@UseGuards(ActiveCompanyGuard)
export class MercadoLivreController {
  constructor(
    private readonly authService: MercadoLivreAuthService,
    private readonly syncService: MercadoLivreSyncService,
  ) {}

  @Get('status')
  status(@Query('companyId') companyId: string) {
    return this.authService.getStatus(companyId);
  }

  @Get('dashboard')
  dashboard(@Query('companyId') companyId: string) {
    return this.syncService.getDashboard(companyId);
  }

  @Get('products')
  products(@Query('companyId') companyId: string) {
    return this.syncService.listProducts(companyId);
  }

  @Get('orders')
  orders(@Query('companyId') companyId: string) {
    return this.syncService.listOrders(companyId);
  }

  @Get('questions')
  questions(@Query('companyId') companyId: string) {
    return this.syncService.listQuestions(companyId);
  }

  @Get('reviews')
  reviews(@Query('companyId') companyId: string) {
    return this.syncService.listReviews(companyId);
  }

  @Post('sync')
  sync(
    @CurrentUser('sub') userId: string,
    @Query('companyId') companyId: string,
  ) {
    return this.syncService.syncAll(companyId, userId);
  }

  @Post('sync/products')
  syncProducts(@Query('companyId') companyId: string) {
    return this.syncService.syncProducts(companyId).then((count) => ({ count }));
  }

  @Post('sync/orders')
  syncOrders(
    @CurrentUser('sub') userId: string,
    @Query('companyId') companyId: string,
  ) {
    return this.syncService.syncOrders(companyId, userId).then((count) => ({ count }));
  }

  @Post('questions/answer')
  answerQuestion(
    @Query('companyId') companyId: string,
    @Body() body: { questionId?: string; text?: string },
  ) {
    return this.syncService.answerQuestion(companyId, String(body.questionId || ''), String(body.text || ''));
  }

  @Post('disconnect')
  disconnect(@Query('companyId') companyId: string) {
    return this.authService.disconnect(companyId);
  }
}
