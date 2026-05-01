import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
import { AppController } from './app.controller';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { AuditInterceptor } from './common/interceptors/audit.interceptor';
import { LoggingMiddleware } from './common/middleware/logging.middleware';
import { PrismaModule } from './prisma/prisma.module';
import { ReportModule } from './report/report.module';
import { validateEnvironment } from './config/env.validation';
import { QueueModule } from './modules/queue/queue.module';
import { AdminModule } from './modules/admin/admin.module';
import { AiModule } from './modules/ai/ai.module';
import { AlertsModule } from './modules/alerts/alerts.module';
import { AnalysisModule } from './modules/analysis/analysis.module';
import { AnalyticsModule } from './modules/analytics/analytics.module';
import { AuthModule } from './modules/auth/auth.module';
import { CompaniesModule } from './modules/companies/companies.module';
import { CompanyPersonalizationModule } from './modules/company-personalization/company-personalization.module';
import { CostsModule } from './modules/costs/costs.module';
import { CustomersModule } from './modules/customers/customers.module';
import { CsvImportsModule } from './modules/csv-imports/csv-imports.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { ExportModule } from './modules/export/export.module';
import { FinanceModule } from './modules/finance/finance.module';
import { InsightsModule } from './modules/insights/insights.module';
import { IntelligentImportsModule } from './modules/intelligent-imports/intelligent-imports.module';
import { IntegrationsModule } from './modules/integrations/integrations.module';
import { MarketIntelligenceModule } from './modules/market-intel/market-intelligence.module';
import { ProductsModule } from './modules/products/products.module';
import { SalesModule } from './modules/sales/sales.module';
import { StrategyModule } from './modules/strategy/strategy.module';
import { UserModule } from './modules/user/user.module';
import { UsageModule } from './modules/usage/usage.module';
import { WebhooksModule } from './modules/webhooks/webhooks.module';
import { WhatsappModule } from './modules/whatsapp/whatsapp.module';

@Module({
  controllers: [AppController],
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnvironment }),
    QueueModule.register(),
    EventEmitterModule.forRoot(),
    ScheduleModule.forRoot(),
    PrismaModule,
    AuthModule,
    CompaniesModule,
    CompanyPersonalizationModule,
    SalesModule,
    InsightsModule,
    IntelligentImportsModule,
    AiModule,
    WebhooksModule,
    DashboardModule,
    FinanceModule,
    UserModule,
    UsageModule,
    ExportModule,
    ProductsModule,
    CustomersModule,
    CostsModule,
    CsvImportsModule,
    AnalyticsModule,
    AlertsModule,
    AnalysisModule,
    IntegrationsModule,
    WhatsappModule,
    StrategyModule,
    MarketIntelligenceModule,
    AdminModule,
    ReportModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_FILTER, useClass: GlobalExceptionFilter },
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
    LoggingMiddleware,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(LoggingMiddleware).forRoutes('*');
  }
}
