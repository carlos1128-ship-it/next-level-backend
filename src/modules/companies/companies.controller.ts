import { Controller, Get, Patch, Body, UseGuards } from '@nestjs/common';
import { CompaniesService } from './companies.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CompanyGuard } from '../../common/guards/company.guard';
import { CompanyId } from '../../common/decorators/company-id.decorator';

@Controller('companies')
@UseGuards(JwtAuthGuard, CompanyGuard)
export class CompaniesController {
  constructor(private readonly companiesService: CompaniesService) {}

  @Get('me')
  async getMyCompany(@CompanyId() companyId: string) {
    return this.companiesService.findById(companyId);
  }

  @Patch('me')
  async updateMyCompany(
    @CompanyId() companyId: string,
    @Body() body: { currency?: string; timezone?: string; name?: string },
  ) {
    return this.companiesService.updateSettings(companyId, body);
  }
}
