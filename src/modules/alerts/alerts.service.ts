import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class AlertsService {
  constructor(private prisma: PrismaService) {}

  async createAlert(data: {
    companyId: string;
    type: string;
    message: string;
    severity: string;
  }) {
    return this.prisma.alert.create({ data });
  }

  async getCompanyAlerts(companyId: string) {
    return this.prisma.alert.findMany({
      where: { companyId },
      orderBy: { createdAt: 'desc' },
    });
  }
}
