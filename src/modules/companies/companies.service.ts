import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateCompanyDto } from './dto/create-company.dto';

@Injectable()
export class CompaniesService {
  private readonly logger = new Logger(CompaniesService.name);
  private companyProfileAvailable: boolean | null = null;
  private companyProfileWarned = false;

  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateCompanyDto, userId: string) {
    if (!userId?.trim()) {
      throw new BadRequestException('userId nao informado');
    }
    if (!dto.name?.trim()) {
      throw new BadRequestException('Nome da empresa e obrigatorio');
    }

    if (this.companyProfileAvailable === false) {
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

    try {
      const created = await this.prisma.company.create({
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
      this.companyProfileAvailable = true;
      this.companyProfileWarned = false;
      return created;
    } catch (error) {
      if (!this.isMissingCompanyProfileColumn(error)) {
        throw error;
      }

      if (!this.companyProfileWarned) {
        this.logger.warn(
          'Company profile columns are missing in the current database. Falling back to legacy company creation.',
        );
        this.companyProfileWarned = true;
      }
      this.companyProfileAvailable = false;

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

    if (this.companyProfileAvailable === false) {
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

    try {
      const companies = await this.prisma.company.findMany({
        where,
        orderBy: { createdAt: 'desc' },
      });
      this.companyProfileAvailable = true;
      this.companyProfileWarned = false;
      return companies;
    } catch (error) {
      if (!this.isMissingCompanyProfileColumn(error)) {
        throw error;
      }

      if (!this.companyProfileWarned) {
        this.logger.warn(
          'Company profile columns are missing in the current database. Falling back to legacy company listing.',
        );
        this.companyProfileWarned = true;
      }
      this.companyProfileAvailable = false;

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

  async remove(companyId: string, userId: string) {
    const normalizedCompanyId = companyId?.trim();
    const normalizedUserId = userId?.trim();

    if (!normalizedCompanyId) {
      throw new BadRequestException('companyId nao informado');
    }

    if (!normalizedUserId) {
      throw new BadRequestException('userId nao informado');
    }

    const company = await this.prisma.company.findFirst({
      where: {
        id: normalizedCompanyId,
        OR: [{ userId: normalizedUserId }, { users: { some: { id: normalizedUserId } } }],
      },
      select: {
        id: true,
        name: true,
        _count: {
          select: {
            financialTransactions: true,
            sales: true,
            products: true,
            customers: true,
            operationalCosts: true,
            leads: true,
          },
        },
      },
    });

    if (!company) {
      throw new NotFoundException('Empresa nao encontrada');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.user.updateMany({
        where: { companyId: normalizedCompanyId },
        data: { companyId: null },
      });

      await tx.company.delete({
        where: { id: normalizedCompanyId },
      });
    });

    this.logger.log(
      `Empresa removida: ${company.id} (${company.name}) com cascata de dados relacionados.`,
    );

    return {
      success: true,
      companyId: company.id,
      companyName: company.name,
      deletedCounts: company._count,
    };
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
