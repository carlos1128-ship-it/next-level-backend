import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
import { AppController } from './app.controller';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';
import { PrismaModule } from './prisma/prisma.module';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { AuthModule } from './modules/auth/auth.module';
import { CompaniesModule } from './modules/companies/companies.module';
import { SalesModule } from './modules/sales/sales.module';
import { InsightsModule } from './modules/insights/insights.module';
import { AiModule } from './modules/ai/ai.module';
import { WebhooksModule } from './modules/webhooks/webhooks.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { FinanceModule } from './modules/finance/finance.module';
import { UserModule } from './modules/user/user.module';
import { ExportModule } from './modules/export/export.module';
import { ProductsModule } from './modules/products/products.module';
import { CustomersModule } from './modules/customers/customers.module';
import { CostsModule } from './modules/costs/costs.module';
import { AnalyticsModule } from './modules/analytics/analytics.module';
import { AlertsModule } from './modules/alerts/alerts.module';
import { AnalysisModule } from './modules/analysis/analysis.module';
import { IntegrationsModule } from './modules/integrations/integrations.module';
import { StrategyModule } from './modules/strategy/strategy.module';
import { MarketIntelligenceModule } from './modules/market-intel/market-intelligence.module';
import { AttendantModule } from './modules/attendant/attendant.module';
import { AdminModule } from './modules/admin/admin.module';
import { BullModule } from '@nestjs/bullmq';
import { LoggingMiddleware } from './common/middleware/logging.middleware';
import { AuditInterceptor } from './common/interceptors/audit.interceptor';
import { ReportModule } from './report/report.module';

@Module({
  controllers: [AppController],
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    BullModule.forRoot({
      connection: {
        url: process.env.REDIS_URL || 'redis://localhost:6379',
      },
    }),
    EventEmitterModule.forRoot(),
    ScheduleModule.forRoot(),
    PrismaModule,
    AuthModule,
    CompaniesModule,
    SalesModule,
    InsightsModule,
    AiModule,
    WebhooksModule,
    DashboardModule,
    FinanceModule,
    UserModule,
    ExportModule,
    ProductsModule,
    CustomersModule,
    CostsModule,
    AnalyticsModule,
    AlertsModule,
    AnalysisModule,
    IntegrationsModule,
    StrategyModule,
    MarketIntelligenceModule,
    AttendantModule,
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
