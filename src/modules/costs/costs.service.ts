import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { OperationalCost, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateCostDto } from './dto/create-cost.dto';
import { ListCostsDto } from './dto/list-costs.dto';
import { UpdateCostDto } from './dto/update-cost.dto';

@Injectable()
export class CostsService {
  constructor(private readonly prisma: PrismaService) {}

  private async resolveCompanyId(
    userId: string,
    requestedCompanyId?: string | null,
    tokenCompanyId?: string | null,
  ): Promise<string> {
    const candidate = (requestedCompanyId || tokenCompanyId || '').trim();
    const userCompanyId =
      candidate ||
      (
        await this.prisma.user.findUnique({
          where: { id: userId },
          select: { companyId: true },
        })
      )?.companyId?.trim();

    if (!userCompanyId) {
      throw new BadRequestException('companyId nao informado');
    }

    const company = await this.prisma.company.findFirst({
      where: {
        id: userCompanyId,
        OR: [{ userId }, { users: { some: { id: userId } } }],
      },
      select: { id: true },
    });

    if (!company) {
      throw new BadRequestException('Empresa invalida');
    }

    return company.id;
  }

  private toDecimal(value: unknown, field: string): Prisma.Decimal {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      throw new BadRequestException(`${field} invalido`);
    }
    return new Prisma.Decimal(numeric);
  }

  private toDate(value: unknown, field: string): Date {
    const date = value instanceof Date ? value : new Date(String(value));
    if (Number.isNaN(date.getTime())) {
      throw new BadRequestException(`${field} invalido`);
    }
    return date;
  }

  private map(cost: OperationalCost) {
    return {
      ...cost,
      amount: Number(cost.amount),
    };
  }

  async create(userId: string, dto: CreateCostDto, tokenCompanyId?: string | null) {
    const companyId = await this.resolveCompanyId(userId, dto.companyId, tokenCompanyId);
    if (!dto.name?.trim()) {
      throw new BadRequestException('Nome do custo e obrigatorio');
    }
    if (dto.amount === undefined || dto.amount === null) {
      throw new BadRequestException('Valor e obrigatorio');
    }
    if (!dto.date) {
      throw new BadRequestException('Data e obrigatoria');
    }

    const created = await this.prisma.operationalCost.create({
      data: {
        companyId,
        name: dto.name.trim(),
        category: dto.category?.trim() || null,
        amount: this.toDecimal(dto.amount, 'amount'),
        date: this.toDate(dto.date, 'date'),
      },
    });

    return this.map(created);
  }

  async findAll(userId: string, query: ListCostsDto, tokenCompanyId?: string | null) {
    const companyId = await this.resolveCompanyId(userId, query.companyId, tokenCompanyId);
    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(Math.max(1, Number(query.limit) || 10), 100);
    const search = query.search?.trim();
    const category = query.category?.trim();
    const startDate = query.startDate ? this.toDate(query.startDate, 'startDate') : null;
    const endDate = query.endDate ? this.toDate(query.endDate, 'endDate') : null;

    const where: Prisma.OperationalCostWhereInput = {
      companyId,
      AND: [
        search
          ? {
              OR: [
                { name: { contains: search, mode: 'insensitive' } },
                { category: { contains: search, mode: 'insensitive' } },
              ],
            }
          : undefined,
        category ? { category: { equals: category, mode: 'insensitive' } } : undefined,
        startDate || endDate
          ? {
              date: {
                gte: startDate || undefined,
                lte: endDate || undefined,
              },
            }
          : undefined,
      ].filter(Boolean) as Prisma.OperationalCostWhereInput[],
    };

    const [total, costs] = await this.prisma.$transaction([
      this.prisma.operationalCost.count({ where }),
      this.prisma.operationalCost.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { date: 'desc' },
      }),
    ]);

    return {
      data: costs.map((item) => this.map(item)),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    };
  }

  async findOne(
    id: string,
    userId: string,
    companyId?: string | null,
    tokenCompanyId?: string | null,
  ) {
    const resolvedCompanyId = await this.resolveCompanyId(userId, companyId, tokenCompanyId);
    const cost = await this.prisma.operationalCost.findFirst({
      where: { id, companyId: resolvedCompanyId },
    });

    if (!cost) {
      throw new NotFoundException('Custo operacional nao encontrado');
    }

    return this.map(cost);
  }

  async update(
    id: string,
    userId: string,
    dto: UpdateCostDto,
    tokenCompanyId?: string | null,
  ) {
    const companyId = await this.resolveCompanyId(userId, dto.companyId, tokenCompanyId);
    const existing = await this.prisma.operationalCost.findFirst({
      where: { id, companyId },
    });

    if (!existing) {
      throw new NotFoundException('Custo operacional nao encontrado');
    }

    const updated = await this.prisma.operationalCost.update({
      where: { id },
      data: {
        name: dto.name?.trim(),
        category: dto.category?.trim() || undefined,
        amount:
          dto.amount !== undefined && dto.amount !== null
            ? this.toDecimal(dto.amount, 'amount')
            : undefined,
        date: dto.date ? this.toDate(dto.date, 'date') : undefined,
      },
    });

    return this.map(updated);
  }

  async remove(
    id: string,
    userId: string,
    companyId?: string | null,
    tokenCompanyId?: string | null,
  ) {
    const resolvedCompanyId = await this.resolveCompanyId(userId, companyId, tokenCompanyId);
    const existing = await this.prisma.operationalCost.findFirst({
      where: { id, companyId: resolvedCompanyId },
    });

    if (!existing) {
      throw new NotFoundException('Custo operacional nao encontrado');
    }

    await this.prisma.operationalCost.delete({ where: { id } });
    return { deleted: true };
  }
}
