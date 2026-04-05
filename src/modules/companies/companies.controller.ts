import { Body, Controller, Delete, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CompaniesService } from './companies.service';
import { CreateCompanyDto } from './dto/create-company.dto';

@UseGuards(JwtAuthGuard)
@Controller('company')
export class CompaniesController {
  constructor(private readonly companiesService: CompaniesService) {}

  @Get()
  findAll(@Req() req: { user: { id: string } }) {
    return this.companiesService.findAll(req.user.id);
  }

  @Post()
  create(@Body() dto: CreateCompanyDto, @Req() req: { user: { id: string } }) {
    return this.companiesService.create(dto, req.user.id);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @Req() req: { user: { id: string } }) {
    return this.companiesService.remove(id, req.user.id);
  }
}
