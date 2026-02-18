import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class CompaniesService {
  constructor(private readonly prisma: PrismaService) {}

  async findById(companyId: string) {
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
    });
    if (!company) {
      throw new NotFoundException('Empresa não encontrada');
    }
    return company;
  }

  async updateSettings(
    companyId: string,
    data: { currency?: string; timezone?: string; name?: string },
  ) {
    await this.findById(companyId);
    return this.prisma.company.update({
      where: { id: companyId },
      data,
    });
  }
}
