import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async getMetrics(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('Usuario nao encontrado');

    const totalSales = await this.prisma.sale.count({
      where: { userId },
    });

    const revenue = await this.prisma.sale.aggregate({
      _sum: { amount: true },
      where: { userId },
    });

    return {
      totalSales,
      revenue: Number(revenue._sum?.amount ?? 0),
    };
  }
}
