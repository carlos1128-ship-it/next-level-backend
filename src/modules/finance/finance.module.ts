import { Module } from '@nestjs/common';
import { FinanceController } from './finance.controller';
import { FinanceService } from './finance.service';
import { TransactionsController } from './transactions.controller';
import { DashboardModule } from '../dashboard/dashboard.module';

@Module({
  imports: [DashboardModule],
  controllers: [FinanceController, TransactionsController],
  providers: [FinanceService],
  exports: [FinanceService],
})
export class FinanceModule {}
