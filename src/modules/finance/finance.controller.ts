import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { CreateTransactionDto } from './dto/create-transaction.dto';
import { ListTransactionsDto } from './dto/list-transactions.dto';
import { FinanceService } from './finance.service';
import { ActiveCompanyGuard } from '../../common/guards/active-company.guard';
import { DashboardService } from '../dashboard/dashboard.service';

@Controller(['finance', 'financial'])
@UseGuards(ActiveCompanyGuard)
export class FinanceController {
  constructor(
    private readonly financeService: FinanceService,
    private readonly dashboardService: DashboardService,
  ) {}

  @Get('summary')
  async getSummary(@CurrentUser('sub') userId: string) {
    return this.dashboardService.getSummary(userId);
  }

  @Get()
  async listTransactionsLegacy(
    @CurrentUser('sub') userId: string,
    @Query() query: ListTransactionsDto,
  ) {
    return this.financeService.listTransactions(userId, query);
  }

  @Get('transactions')
  async listTransactions(
    @CurrentUser('sub') userId: string,
    @Query() query: ListTransactionsDto,
  ) {
    return this.financeService.listTransactions(userId, query);
  }

  @Post('transactions')
  async createTransaction(
    @CurrentUser('sub') userId: string,
    @Body() dto: CreateTransactionDto,
  ) {
    return this.financeService.createTransaction(userId, dto);
  }

  @Post()
  async createTransactionLegacy(
    @CurrentUser('sub') userId: string,
    @Body() dto: CreateTransactionDto,
  ) {
    return this.financeService.createTransaction(userId, dto);
  }
}
