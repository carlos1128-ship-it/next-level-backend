import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CreateTransactionDto } from './dto/create-transaction.dto';
import { ListTransactionsDto } from './dto/list-transactions.dto';
import { FinanceService } from './finance.service';
import { ActiveCompanyGuard } from '../../common/guards/active-company.guard';
import { DashboardService } from '../dashboard/dashboard.service';

@Controller('financial')
@UseGuards(JwtAuthGuard, ActiveCompanyGuard)
export class FinanceController {
  constructor(
    private readonly financeService: FinanceService,
    private readonly dashboardService: DashboardService,
  ) {}

  @Get('summary')
  async getSummary(@Req() req: { user: { id: string } }) {
    return this.dashboardService.getSummary(req.user.id);
  }

  @Get()
  async listTransactionsLegacy(
    @Req() req: { user: { id: string } },
    @Query() query: ListTransactionsDto,
  ) {
    return this.financeService.listTransactions(req.user.id, query);
  }

  @Get('transactions')
  findAll(@Query('companyId') companyId: string, @Req() req: { user: { id: string } }) {
    return this.financeService.findAll(companyId, req.user.id);
  }

  @Get('report')
  getReport(@Query('companyId') companyId: string, @Req() req: { user: { id: string } }) {
    return this.financeService.getReport(companyId, req.user.id);
  }

  @Post('transactions')
  create(@Body() dto: CreateTransactionDto, @Req() req: { user: { id: string } }) {
    return this.financeService.createTransaction(dto, req.user.id);
  }

  @Post()
  async createTransactionLegacy(
    @Req() req: { user: { id: string } },
    @Body() dto: CreateTransactionDto,
  ) {
    return this.financeService.createTransaction(dto, req.user.id);
  }

  @Get(':companyId')
  async listTransactionsByCompany(
    @Req() req: { user: { id: string } },
    @Param('companyId') companyId: string,
    @Query() query: ListTransactionsDto,
  ) {
    return this.financeService.listTransactionsByCompany(req.user.id, companyId, query);
  }
}
