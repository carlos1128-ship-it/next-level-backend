import { Body, Controller, Delete, Get, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { ActiveCompanyGuard } from '../../common/guards/active-company.guard';
import { CreateProductDto } from './dto/create-product.dto';
import { ListProductsDto } from './dto/list-products.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { ProductsService } from './products.service';

@Controller('products')
@UseGuards(ActiveCompanyGuard)
export class ProductsController {
  constructor(private readonly productsService: ProductsService) {}

  @Post()
  create(
    @Req() req: { user: { id: string; companyId?: string | null } },
    @Body() body: CreateProductDto,
    @Query('companyId') companyId?: string,
  ) {
    return this.productsService.create(req.user.id, body, companyId || req.user.companyId);
  }

  @Get()
  list(
    @Req() req: { user: { id: string; companyId?: string | null } },
    @Query() query: ListProductsDto,
  ) {
    return this.productsService.findAll(req.user.id, query, req.user.companyId);
  }

  @Get(':id')
  findOne(
    @Param('id') id: string,
    @Req() req: { user: { id: string; companyId?: string | null } },
    @Query('companyId') companyId?: string,
  ) {
    return this.productsService.findOne(id, req.user.id, companyId, req.user.companyId);
  }

  @Put(':id')
  update(
    @Param('id') id: string,
    @Req() req: { user: { id: string; companyId?: string | null } },
    @Body() body: UpdateProductDto,
    @Query('companyId') companyId?: string,
  ) {
    return this.productsService.update(id, req.user.id, body, companyId || req.user.companyId);
  }

  @Delete(':id')
  delete(
    @Param('id') id: string,
    @Req() req: { user: { id: string; companyId?: string | null } },
    @Query('companyId') companyId?: string,
  ) {
    return this.productsService.remove(id, req.user.id, companyId, req.user.companyId);
  }
}
