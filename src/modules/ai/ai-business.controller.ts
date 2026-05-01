import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentUser, JwtPayload } from '../../common/decorators/current-user.decorator';
import { ActiveCompanyGuard } from '../../common/guards/active-company.guard';
import { AiBrainService } from './ai-brain.service';
import { AiAlertService } from './ai-alert.service';
import { AiRecommendationService } from './ai-recommendation.service';
import { AiWhatsAppAnalysisService } from './ai-whatsapp-analysis.service';

@Controller('ai')
@UseGuards(ActiveCompanyGuard)
export class AiBusinessController {
  constructor(
    private readonly aiBrainService: AiBrainService,
    private readonly aiAlertService: AiAlertService,
    private readonly aiRecommendationService: AiRecommendationService,
    private readonly aiWhatsAppAnalysisService: AiWhatsAppAnalysisService,
  ) {}

  @Get('dashboard-insights')
  getDashboardInsights(@CurrentUser() user: JwtPayload, @Query('period') period?: string) {
    return this.aiBrainService.generateDashboardInsights(this.companyId(user), period);
  }

  @Get('business-diagnosis')
  getBusinessDiagnosis(@CurrentUser() user: JwtPayload, @Query('period') period?: string) {
    return this.aiBrainService.generateBusinessDiagnosis(this.companyId(user), period);
  }

  @Get('financial-insights')
  getFinancialInsights(@CurrentUser() user: JwtPayload, @Query('period') period?: string) {
    return this.aiBrainService.generateFinancialInsights(this.companyId(user), period);
  }

  @Get('product-insights')
  getProductInsights(@CurrentUser() user: JwtPayload, @Query('period') period?: string) {
    return this.aiBrainService.generateProductInsights(this.companyId(user), period);
  }

  @Get('customer-insights')
  getCustomerInsights(@CurrentUser() user: JwtPayload, @Query('period') period?: string) {
    return this.aiBrainService.generateCustomerInsights(this.companyId(user), period);
  }

  @Get('operational-insights')
  getOperationalInsights(@CurrentUser() user: JwtPayload, @Query('period') period?: string) {
    return this.aiBrainService.generateOperationalInsights(this.companyId(user), period);
  }

  @Post('ask')
  ask(@CurrentUser() user: JwtPayload, @Body('question') question: string, @Body('period') period?: string) {
    return this.aiBrainService.answerBusinessQuestion(this.companyId(user), question || '', period);
  }

  @Post('generate-report')
  generateReport(@CurrentUser() user: JwtPayload, @Body('period') period?: string) {
    return this.aiBrainService.generateExecutiveReport(this.companyId(user), period);
  }

  @Get('alerts')
  getAlerts(@CurrentUser() user: JwtPayload, @Query('status') status?: string) {
    return this.aiAlertService.listAlerts(this.companyId(user), status);
  }

  @Patch('alerts/:id/resolve')
  resolveAlert(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.aiAlertService.resolveAlert(this.companyId(user), id);
  }

  @Get('recommendations')
  getRecommendations(@CurrentUser() user: JwtPayload, @Query('status') status?: string) {
    return this.aiRecommendationService.listRecommendations(this.companyId(user), status);
  }

  @Patch('recommendations/:id/status')
  updateRecommendationStatus(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body('status') status: string,
  ) {
    return this.aiRecommendationService.updateStatus(this.companyId(user), id, status || 'suggested');
  }

  @Post('whatsapp/analyze-message')
  analyzeWhatsappMessage(
    @CurrentUser() user: JwtPayload,
    @Body() body: { conversationId: string; message?: string; customerId?: string | null; metadataJson?: Record<string, unknown> },
  ) {
    return this.aiWhatsAppAnalysisService.analyzeMessage(this.companyId(user), body);
  }

  @Post('events/process')
  processEvents(@CurrentUser() user: JwtPayload, @Body('period') period?: string) {
    return this.aiBrainService.generateDashboardInsights(this.companyId(user), period);
  }

  private companyId(user: JwtPayload) {
    return String(user.companyId || '');
  }
}
