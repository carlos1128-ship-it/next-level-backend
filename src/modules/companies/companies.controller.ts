import { Body, Controller, Get, Post } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { CreateCompanyDto } from './dto/create-company.dto';
import { CompaniesService } from './companies.service';

@Controller(['company', 'companies'])
export class CompaniesController {
  constructor(private readonly companiesService: CompaniesService) {}

  @Get()
  async getMyCompany(@CurrentUser('sub') userId: string) {
    return this.companiesService.getCurrentCompany(userId);
  }

  @Post()
  async createCompany(
    @CurrentUser('sub') userId: string,
    @Body() dto: CreateCompanyDto,
  ) {
    return this.companiesService.createCompany(userId, dto);
  }
}
