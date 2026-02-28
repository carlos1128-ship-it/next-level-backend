import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class CompaniesService {
  constructor(private readonly prisma: PrismaService) {}

  async create(name: string, userId: string) {
    if (!userId?.trim()) {
      throw new BadRequestException('userId nao informado');
    }
    if (!name?.trim()) {
      throw new BadRequestException('Nome da empresa e obrigatorio');
    }

    return this.prisma.company.create({
      data: {
        name: name.trim(),
        userId: userId.trim(),
      },
    });
  }

  async findAll(userId: string) {
    return this.prisma.company.findMany({
      where: {
        OR: [{ userId }, { users: { some: { id: userId } } }],
      },
      orderBy: { createdAt: 'desc' },
    });
  }
}
