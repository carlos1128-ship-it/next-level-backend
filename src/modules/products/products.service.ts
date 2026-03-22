import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, Product } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { ListProductsDto } from './dto/list-products.dto';

@Injectable()
export class ProductsService {
  constructor(private readonly prisma: PrismaService) {}

  calculateFinancials(product: { price: number; cost?: number | null }) {
    const price = Number(product.price || 0);
    const cost = Number(product.cost || 0);
    const grossProfit = Number((price - cost).toFixed(2));
    const netMargin = price > 0 ? Number(((grossProfit / price) * 100).toFixed(2)) : 0;
    const warningLevel =
      netMargin <= 0 ? 'CRITICAL' : netMargin < 10 ? 'WARNING' : 'HEALTHY';

    return {
      grossProfit,
      netMargin,
      warningLevel,
    };
  }

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

  private map(product: Product) {
    const mapped = {
      ...product,
      price: Number(product.price),
      cost: product.cost != null ? Number(product.cost) : null,
    };

    return {
      ...mapped,
      financials: this.calculateFinancials(mapped),
    };
  }

  async create(userId: string, dto: CreateProductDto, tokenCompanyId?: string | null) {
    const companyId = await this.resolveCompanyId(userId, dto.companyId, tokenCompanyId);

    if (!dto.name?.trim()) {
      throw new BadRequestException('Nome do produto e obrigatorio');
    }
    if (dto.price === undefined || dto.price === null) {
      throw new BadRequestException('Preco e obrigatorio');
    }

    const product = await this.prisma.product.create({
      data: {
        companyId,
        name: dto.name.trim(),
        sku: dto.sku?.trim() || null,
        category: dto.category?.trim() || null,
        price: this.toDecimal(dto.price, 'price'),
        cost: dto.cost !== undefined && dto.cost !== null ? this.toDecimal(dto.cost, 'cost') : null,
      },
    });

    return this.map(product);
  }

  async findAll(userId: string, query: ListProductsDto, tokenCompanyId?: string | null) {
    const companyId = await this.resolveCompanyId(userId, query.companyId, tokenCompanyId);
    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(Math.max(1, Number(query.limit) || 10), 100);
    const search = query.search?.trim();
    const category = query.category?.trim();
    const minPrice =
      query.minPrice !== undefined && query.minPrice !== null
        ? this.toDecimal(query.minPrice, 'minPrice')
        : null;
    const maxPrice =
      query.maxPrice !== undefined && query.maxPrice !== null
        ? this.toDecimal(query.maxPrice, 'maxPrice')
        : null;

    const where: Prisma.ProductWhereInput = {
      companyId,
      AND: [
        search
          ? {
              OR: [
                { name: { contains: search, mode: 'insensitive' } },
                { sku: { contains: search, mode: 'insensitive' } },
                { category: { contains: search, mode: 'insensitive' } },
              ],
            }
          : undefined,
        category ? { category: { equals: category, mode: 'insensitive' } } : undefined,
        minPrice ? { price: { gte: minPrice } } : undefined,
        maxPrice ? { price: { lte: maxPrice } } : undefined,
      ].filter(Boolean) as Prisma.ProductWhereInput[],
    };

    const [total, products] = await this.prisma.$transaction([
      this.prisma.product.count({ where }),
      this.prisma.product.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    return {
      data: products.map((product) => this.map(product)),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    };
  }

  async findOne(id: string, userId: string, companyId?: string | null, tokenCompanyId?: string | null) {
    const resolvedCompanyId = await this.resolveCompanyId(userId, companyId, tokenCompanyId);
    const product = await this.prisma.product.findFirst({
      where: { id, companyId: resolvedCompanyId },
    });

    if (!product) {
      throw new NotFoundException('Produto nao encontrado');
    }

    return this.map(product);
  }

  async update(
    id: string,
    userId: string,
    dto: UpdateProductDto,
    tokenCompanyId?: string | null,
  ) {
    const companyId = await this.resolveCompanyId(userId, dto.companyId, tokenCompanyId);
    const existing = await this.prisma.product.findFirst({ where: { id, companyId } });
    if (!existing) {
      throw new NotFoundException('Produto nao encontrado');
    }

    const data: Prisma.ProductUpdateInput = {
      name: dto.name?.trim(),
      sku: dto.sku?.trim() || undefined,
      category: dto.category?.trim() || undefined,
      price:
        dto.price !== undefined && dto.price !== null
          ? this.toDecimal(dto.price, 'price')
          : undefined,
      cost:
        dto.cost !== undefined
          ? dto.cost === null
            ? null
            : this.toDecimal(dto.cost, 'cost')
          : undefined,
    };

    const updated = await this.prisma.product.update({
      where: { id },
      data,
    });

    return this.map(updated);
  }

  async remove(id: string, userId: string, companyId?: string | null, tokenCompanyId?: string | null) {
    const resolvedCompanyId = await this.resolveCompanyId(userId, companyId, tokenCompanyId);
    const existing = await this.prisma.product.findFirst({
      where: { id, companyId: resolvedCompanyId },
    });

    if (!existing) {
      throw new NotFoundException('Produto nao encontrado');
    }

    await this.prisma.product.delete({ where: { id } });
    return { deleted: true };
  }
}
