import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { CreateTransactionDto } from './dto/create-transaction.dto';
import { ListTransactionsDto } from './dto/list-transactions.dto';
import { FinanceService } from './finance.service';

@Controller('finance')
export class FinanceController {
  constructor(private readonly financeService: FinanceService) {}

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
}
