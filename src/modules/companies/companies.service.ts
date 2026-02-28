import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateCompanyDto } from './dto/create-company.dto';

export interface CompanyDefaults {
  id: string;
  name: string;
  slug: string;
  currency: string;
  timezone: string;
}

@Injectable()
export class CompaniesService {
  constructor(private readonly prisma: PrismaService) {}

  async getCurrentCompany(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { companyId: true },
    });

    if (!user) {
      return this.defaultCompany();
    }

    const companyId = user.companyId?.trim() || undefined;
    if (!companyId) {
      return this.createAndAttachInitialCompany(userId);
    }

    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
    });
    if (!company) {
      return this.createAndAttachInitialCompany(userId);
    }

    return company;
  }

  async createCompany(userId: string, dto: CreateCompanyDto) {
    if (!userId?.trim()) {
      throw new BadRequestException('userId nao informado');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { companyId: true },
    });

    if (!user) {
      throw new BadRequestException('Usuario nao encontrado');
    }

    const companyId = user?.companyId?.trim() || undefined;

    if (companyId) {
      const existing = await this.prisma.company.findUnique({
        where: { id: companyId },
      });
      if (existing) {
        return existing;
      }
    }

    const slugBase = dto.slug?.trim() || this.slugify(dto.name);
    const slug = await this.ensureUniqueSlug(slugBase);

    const company = await this.prisma.company.create({
      data: {
        name: dto.name.trim(),
        slug,
        currency: dto.currency?.trim() || 'BRL',
        timezone: dto.timezone?.trim() || 'America/Sao_Paulo',
      },
    });

    if (user) {
      await this.prisma.user.update({
        where: { id: userId },
        data: { companyId: company.id },
      });
    }

    return company;
  }

  private async createAndAttachInitialCompany(userId: string) {
    const slug = await this.ensureUniqueSlug('empresa-inicial');
    const company = await this.prisma.company.create({
      data: {
        name: 'Empresa Inicial',
        slug,
        currency: 'BRL',
        timezone: 'America/Sao_Paulo',
      },
    });

    await this.prisma.user.update({
      where: { id: userId },
      data: { companyId: company.id },
    });

    return company;
  }

  private defaultCompany(): CompanyDefaults {
    return {
      id: '',
      name: '',
      slug: '',
      currency: 'BRL',
      timezone: 'America/Sao_Paulo',
    };
  }

  private slugify(value: string): string {
    return value
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 50);
  }

  private async ensureUniqueSlug(base: string): Promise<string> {
    const safeBase = base || 'company';
    let candidate = safeBase;
    let attempt = 1;

    while (attempt < 100) {
      const exists = await this.prisma.company.findUnique({
        where: { slug: candidate },
        select: { id: true },
      });

      if (!exists) {
        return candidate;
      }

      attempt += 1;
      candidate = `${safeBase}-${attempt}`;
    }

    throw new ConflictException('Nao foi possivel gerar slug unico para a empresa');
  }
}
