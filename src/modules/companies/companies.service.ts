import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateCompanyDto } from './dto/create-company.dto';

@Injectable()
export class CompaniesService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateCompanyDto, userId: string) {
    if (!userId?.trim()) {
      throw new BadRequestException('userId nao informado');
    }
    if (!dto.name?.trim()) {
      throw new BadRequestException('Nome da empresa e obrigatorio');
    }

    return this.prisma.company.create({
      data: {
        name: dto.name.trim(),
        sector: dto.sector?.trim() || null,
        segment: dto.segment?.trim() || null,
        document: dto.document?.trim() || null,
        description: dto.description?.trim() || null,
        openedAt: dto.openedAt ? new Date(dto.openedAt) : null,
        slug: dto.slug?.trim() || undefined,
        currency: dto.currency?.trim() || undefined,
        timezone: dto.timezone?.trim() || undefined,
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
