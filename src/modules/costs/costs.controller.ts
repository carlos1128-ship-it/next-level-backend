import { Body, Controller, Delete, Get, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { ActiveCompanyGuard } from '../../common/guards/active-company.guard';
import { CreateCostDto } from './dto/create-cost.dto';
import { ListCostsDto } from './dto/list-costs.dto';
import { UpdateCostDto } from './dto/update-cost.dto';
import { CostsService } from './costs.service';

@Controller('costs')
@UseGuards(ActiveCompanyGuard)
export class CostsController {
  constructor(private readonly costsService: CostsService) {}

  @Post()
  create(
    @Req() req: { user: { id: string; companyId?: string | null } },
    @Body() body: CreateCostDto,
    @Query('companyId') companyId?: string,
  ) {
    return this.costsService.create(req.user.id, body, companyId || req.user.companyId);
  }

  @Get()
  list(
    @Req() req: { user: { id: string; companyId?: string | null } },
    @Query() query: ListCostsDto,
  ) {
    return this.costsService.findAll(req.user.id, query, req.user.companyId);
  }

  @Get(':id')
  findOne(
    @Param('id') id: string,
    @Req() req: { user: { id: string; companyId?: string | null } },
    @Query('companyId') companyId?: string,
  ) {
    return this.costsService.findOne(id, req.user.id, companyId, req.user.companyId);
  }

  @Put(':id')
  update(
    @Param('id') id: string,
    @Req() req: { user: { id: string; companyId?: string | null } },
    @Body() body: UpdateCostDto,
    @Query('companyId') companyId?: string,
  ) {
    return this.costsService.update(id, req.user.id, body, companyId || req.user.companyId);
  }

  @Delete(':id')
  delete(
    @Param('id') id: string,
    @Req() req: { user: { id: string; companyId?: string | null } },
    @Query('companyId') companyId?: string,
  ) {
    return this.costsService.remove(id, req.user.id, companyId, req.user.companyId);
  }
}
