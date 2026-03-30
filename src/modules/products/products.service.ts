import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { ListProductsDto } from './dto/list-products.dto';

export type FinancialWarningLevel = 'HEALTHY' | 'WARNING' | 'CRITICAL';

type ProductFieldAvailability = {
  tax: boolean;
  shipping: boolean;
};

type ProductRecord = {
  id: string;
  companyId: string;
  name: string;
  sku: string | null;
  category: string | null;
  price: Prisma.Decimal;
  cost: Prisma.Decimal | null;
  tax?: Prisma.Decimal | null;
  shipping?: Prisma.Decimal | null;
  createdAt: Date;
  updatedAt: Date;
};

@Injectable()
export class ProductsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Lucro líquido estimado por unidade e margem sobre o preço de venda.
   * `grossProfit` aqui = preço − custo − imposto − frete (nomenclatura alinhada ao requisito de “lucro líquido” no item).
   */
  calculateFinancialHealth(
    cost: number,
    tax: number,
    shipping: number,
    price: number,
  ): { grossProfit: number; netMargin: number; warningLevel: FinancialWarningLevel } {
    const safeCost = Math.max(0, Number(cost) || 0);
    const safeTax = Math.max(0, Number(tax) || 0);
    const safeShip = Math.max(0, Number(shipping) || 0);
    const safePrice = Math.max(0, Number(price) || 0);
    const grossProfit = Number((safePrice - safeCost - safeTax - safeShip).toFixed(2));
    const netMargin =
      safePrice > 0 ? Number(((grossProfit / safePrice) * 100).toFixed(2)) : 0;
    const warningLevel: FinancialWarningLevel =
      netMargin <= 0 ? 'CRITICAL' : netMargin < 10 ? 'WARNING' : 'HEALTHY';

    return { grossProfit, netMargin, warningLevel };
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

  private async resolveProductFieldAvailability(): Promise<ProductFieldAvailability> {
    const [tax, shipping] = await Promise.all([
      this.prisma.hasColumn('Product', 'tax'),
      this.prisma.hasColumn('Product', 'shipping'),
    ]);

    return { tax, shipping };
  }

  private buildProductSelect(fieldAvailability: ProductFieldAvailability): Prisma.ProductSelect {
    return {
      id: true,
      companyId: true,
      name: true,
      sku: true,
      category: true,
      price: true,
      cost: true,
      ...(fieldAvailability.tax ? { tax: true } : {}),
      ...(fieldAvailability.shipping ? { shipping: true } : {}),
      createdAt: true,
      updatedAt: true,
    };
  }

  private normalizeProductRecord(product: ProductRecord): ProductRecord {
    return {
      ...product,
      tax: product.tax ?? null,
      shipping: product.shipping ?? null,
    };
  }

  private map(product: ProductRecord) {
    const normalized = this.normalizeProductRecord(product);
    const price = Number(normalized.price);
    const costNum = normalized.cost != null ? Number(normalized.cost) : 0;
    const taxNum = normalized.tax != null ? Number(normalized.tax) : 0;
    const shipNum = normalized.shipping != null ? Number(normalized.shipping) : 0;

    const mapped = {
      ...normalized,
      price,
      cost: normalized.cost != null ? Number(normalized.cost) : null,
      tax: normalized.tax != null ? Number(normalized.tax) : null,
      shipping: normalized.shipping != null ? Number(normalized.shipping) : null,
    };

    return {
      ...mapped,
      financials: this.calculateFinancialHealth(costNum, taxNum, shipNum, price),
    };
  }

  async create(userId: string, dto: CreateProductDto, tokenCompanyId?: string | null) {
    const fieldAvailability = await this.resolveProductFieldAvailability();
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
        ...(fieldAvailability.tax
          ? {
              tax:
                dto.tax !== undefined && dto.tax !== null ? this.toDecimal(dto.tax, 'tax') : null,
            }
          : {}),
        ...(fieldAvailability.shipping
          ? {
              shipping:
                dto.shipping !== undefined && dto.shipping !== null
                  ? this.toDecimal(dto.shipping, 'shipping')
                  : null,
            }
          : {}),
      },
      select: this.buildProductSelect(fieldAvailability),
    });

    return this.map(product as ProductRecord);
  }

  async findAll(userId: string, query: ListProductsDto, tokenCompanyId?: string | null) {
    const fieldAvailability = await this.resolveProductFieldAvailability();
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
        select: this.buildProductSelect(fieldAvailability),
      }),
    ]);

    return {
      data: products.map((product) => this.map(product as ProductRecord)),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    };
  }

  async findOne(id: string, userId: string, companyId?: string | null, tokenCompanyId?: string | null) {
    const fieldAvailability = await this.resolveProductFieldAvailability();
    const resolvedCompanyId = await this.resolveCompanyId(userId, companyId, tokenCompanyId);
    const product = (await this.prisma.product.findFirst({
      where: { id, companyId: resolvedCompanyId },
      select: this.buildProductSelect(fieldAvailability),
    })) as ProductRecord | null;

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
    const fieldAvailability = await this.resolveProductFieldAvailability();
    const companyId = await this.resolveCompanyId(userId, dto.companyId, tokenCompanyId);
    const existing = await this.prisma.product.findFirst({
      where: { id, companyId },
      select: { id: true },
    });
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
      ...(fieldAvailability.tax
        ? {
            tax:
              dto.tax !== undefined
                ? dto.tax === null
                  ? null
                  : this.toDecimal(dto.tax, 'tax')
                : undefined,
          }
        : {}),
      ...(fieldAvailability.shipping
        ? {
            shipping:
              dto.shipping !== undefined
                ? dto.shipping === null
                  ? null
                  : this.toDecimal(dto.shipping, 'shipping')
                : undefined,
          }
        : {}),
    };

    const updated = await this.prisma.product.update({
      where: { id },
      data,
      select: this.buildProductSelect(fieldAvailability),
    });

    return this.map(updated as ProductRecord);
  }

  async remove(id: string, userId: string, companyId?: string | null, tokenCompanyId?: string | null) {
    const resolvedCompanyId = await this.resolveCompanyId(userId, companyId, tokenCompanyId);
    const existing = await this.prisma.product.findFirst({
      where: { id, companyId: resolvedCompanyId },
      select: { id: true },
    });

    if (!existing) {
      throw new NotFoundException('Produto nao encontrado');
    }

    await this.prisma.product.delete({ where: { id } });
    return { deleted: true };
  }
}
