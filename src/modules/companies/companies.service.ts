import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateCompanyDto } from './dto/create-company.dto';

@Injectable()
export class CompaniesService {
  private readonly logger = new Logger(CompaniesService.name);

  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateCompanyDto, userId: string) {
    if (!userId?.trim()) {
      throw new BadRequestException('userId nao informado');
    }
    if (!dto.name?.trim()) {
      throw new BadRequestException('Nome da empresa e obrigatorio');
    }

    try {
      return await this.prisma.company.create({
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
    } catch (error) {
      if (!this.isMissingCompanyProfileColumn(error)) {
        throw error;
      }

      this.logger.warn(
        'Company profile columns are missing in the current database. Falling back to legacy company creation.',
      );

      return this.prisma.company.create({
        data: {
          name: dto.name.trim(),
          slug: dto.slug?.trim() || undefined,
          currency: dto.currency?.trim() || undefined,
          timezone: dto.timezone?.trim() || undefined,
          userId: userId.trim(),
        },
      });
    }
  }

  async findAll(userId: string) {
    const where = {
      OR: [{ userId }, { users: { some: { id: userId } } }],
    };

    try {
      return await this.prisma.company.findMany({
        where,
        orderBy: { createdAt: 'desc' },
      });
    } catch (error) {
      if (!this.isMissingCompanyProfileColumn(error)) {
        throw error;
      }

      this.logger.warn(
        'Company profile columns are missing in the current database. Falling back to legacy company listing.',
      );

      return this.prisma.company.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          userId: true,
          name: true,
          slug: true,
          currency: true,
          timezone: true,
          createdAt: true,
          updatedAt: true,
        },
      });
    }
  }

  private isMissingCompanyProfileColumn(error: unknown): boolean {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      return error.code === 'P2021' || error.code === 'P2022';
    }

    if (error instanceof Error) {
      const message = error.message.toLowerCase();
      return (
        message.includes('company.') &&
        (message.includes('does not exist') ||
          message.includes('column') ||
          message.includes('relation'))
      );
    }

    return false;
  }
}
