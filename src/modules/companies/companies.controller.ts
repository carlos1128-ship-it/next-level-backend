import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CompaniesService } from './companies.service';

@UseGuards(JwtAuthGuard)
@Controller('company')
export class CompaniesController {
  constructor(private readonly companiesService: CompaniesService) {}

  @Get()
  findAll(@Req() req: { user: { id: string } }) {
    return this.companiesService.findAll(req.user.id);
  }

  @Post()
  create(@Body() body: { name: string }, @Req() req: { user: { id: string } }) {
    return this.companiesService.create(body.name, req.user.id);
  }
}
