import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, Customer } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateCustomerDto } from './dto/create-customer.dto';
import { ListCustomersDto } from './dto/list-customers.dto';
import { UpdateCustomerDto } from './dto/update-customer.dto';

@Injectable()
export class CustomersService {
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

  private map(customer: Customer) {
    return customer;
  }

  async create(userId: string, dto: CreateCustomerDto, tokenCompanyId?: string | null) {
    const companyId = await this.resolveCompanyId(userId, dto.companyId, tokenCompanyId);
    if (!dto.name?.trim()) {
      throw new BadRequestException('Nome do cliente e obrigatorio');
    }

    const created = await this.prisma.customer.create({
      data: {
        companyId,
        name: dto.name.trim(),
        email: dto.email?.trim() || null,
        phone: dto.phone?.trim() || null,
      },
    });

    await this.prisma.businessEvent.create({
      data: {
        companyId,
        source: 'customer',
        type: 'customer_created',
        title: 'Cliente registrado',
        description: created.name,
        metadataJson: { customerId: created.id, hasEmail: Boolean(created.email), hasPhone: Boolean(created.phone) },
        occurredAt: created.createdAt,
      },
    });

    return this.map(created);
  }

  async findAll(userId: string, query: ListCustomersDto, tokenCompanyId?: string | null) {
    const companyId = await this.resolveCompanyId(userId, query.companyId, tokenCompanyId);
    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(Math.max(1, Number(query.limit) || 10), 100);
    const search = query.search?.trim();

    const where: Prisma.CustomerWhereInput = {
      companyId,
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: 'insensitive' } },
              { email: { contains: search, mode: 'insensitive' } },
              { phone: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [total, customers] = await this.prisma.$transaction([
      this.prisma.customer.count({ where }),
      this.prisma.customer.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    return {
      data: customers.map((item) => this.map(item)),
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
    const customer = await this.prisma.customer.findFirst({
      where: { id, companyId: resolvedCompanyId },
    });

    if (!customer) {
      throw new NotFoundException('Cliente nao encontrado');
    }

    return this.map(customer);
  }

  async update(
    id: string,
    userId: string,
    dto: UpdateCustomerDto,
    tokenCompanyId?: string | null,
  ) {
    const companyId = await this.resolveCompanyId(userId, dto.companyId, tokenCompanyId);
    const existing = await this.prisma.customer.findFirst({
      where: { id, companyId },
    });

    if (!existing) {
      throw new NotFoundException('Cliente nao encontrado');
    }

    const updated = await this.prisma.customer.update({
      where: { id },
      data: {
        name: dto.name?.trim(),
        email: dto.email?.trim() || undefined,
        phone: dto.phone?.trim() || undefined,
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
    const existing = await this.prisma.customer.findFirst({
      where: { id, companyId: resolvedCompanyId },
    });

    if (!existing) {
      throw new NotFoundException('Cliente nao encontrado');
    }

    await this.prisma.customer.delete({ where: { id } });
    return { deleted: true };
  }
}
