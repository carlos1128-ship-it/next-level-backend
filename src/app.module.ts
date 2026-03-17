import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
import { AppController } from './app.controller';
import { AllExceptionsFilter } from './common/filters/http-exception.filter';
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

@Module({
  controllers: [AppController],
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
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
  ],
  providers: [
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
