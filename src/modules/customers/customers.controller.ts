import { Body, Controller, Delete, Get, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { ActiveCompanyGuard } from '../../common/guards/active-company.guard';
import { CreateCustomerDto } from './dto/create-customer.dto';
import { ListCustomersDto } from './dto/list-customers.dto';
import { UpdateCustomerDto } from './dto/update-customer.dto';
import { CustomersService } from './customers.service';

@Controller('customers')
@UseGuards(ActiveCompanyGuard)
export class CustomersController {
  constructor(private readonly customersService: CustomersService) {}

  @Post()
  create(
    @Req() req: { user: { id: string; companyId?: string | null } },
    @Body() body: CreateCustomerDto,
    @Query('companyId') companyId?: string,
  ) {
    return this.customersService.create(req.user.id, body, companyId || req.user.companyId);
  }

  @Get()
  list(
    @Req() req: { user: { id: string; companyId?: string | null } },
    @Query() query: ListCustomersDto,
  ) {
    return this.customersService.findAll(req.user.id, query, req.user.companyId);
  }

  @Get(':id')
  findOne(
    @Param('id') id: string,
    @Req() req: { user: { id: string; companyId?: string | null } },
    @Query('companyId') companyId?: string,
  ) {
    return this.customersService.findOne(id, req.user.id, companyId, req.user.companyId);
  }

  @Put(':id')
  update(
    @Param('id') id: string,
    @Req() req: { user: { id: string; companyId?: string | null } },
    @Body() body: UpdateCustomerDto,
    @Query('companyId') companyId?: string,
  ) {
    return this.customersService.update(id, req.user.id, body, companyId || req.user.companyId);
  }

  @Delete(':id')
  delete(
    @Param('id') id: string,
    @Req() req: { user: { id: string; companyId?: string | null } },
    @Query('companyId') companyId?: string,
  ) {
    return this.customersService.remove(id, req.user.id, companyId, req.user.companyId);
  }
}
