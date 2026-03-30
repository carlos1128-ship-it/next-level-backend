import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PeriodQueryDto } from '../../common/dto/period-query.dto';
import { CreateSaleDto } from './dto/create-sale.dto';
import { UpdateSaleDto } from './dto/update-sale.dto';
import { SalesService } from './sales.service';

interface JwtRequest extends Request {
  user: { id: string };
}

@Controller('sales')
@UseGuards(JwtAuthGuard)
export class SalesController {
  constructor(private readonly salesService: SalesService) {}

  @Post()
  async create(@Req() req: JwtRequest, @Body() dto: CreateSaleDto) {
    return this.salesService.create(req.user.id, dto);
  }

  @Get()
  async list(@Req() req: JwtRequest, @Query() query: PeriodQueryDto) {
    const { start, end } = query;
    const startDate = start
      ? new Date(start)
      : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const endDate = end ? new Date(end) : new Date();
    return this.salesService.findByUserAndPeriod(req.user.id, startDate, endDate);
  }

  @Patch(':id')
  async update(
    @Req() req: JwtRequest,
    @Param('id') id: string,
    @Body() dto: UpdateSaleDto,
  ) {
    return this.salesService.update(id, req.user.id, dto);
  }

  @Delete(':id')
  async remove(@Req() req: JwtRequest, @Param('id') id: string) {
    return this.salesService.remove(id, req.user.id);
  }

  @Get('aggregates')
  async aggregates(@Req() req: JwtRequest, @Query() query: PeriodQueryDto) {
    const { start, end } = query;
    if (start && end) {
      const startDate = new Date(start);
      const endDate = new Date(end);
      return this.salesService.getAggregatesByUserAndPeriod(
        req.user.id,
        startDate,
        endDate,
      );
    }
    return this.salesService.getDashboardAggregates(req.user.id);
  }
}
