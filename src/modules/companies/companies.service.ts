import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
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

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { companyId: true },
    });

    if (!user) {
      throw new BadRequestException('Usuario nao encontrado');
    }
    const slugBase = this.slugify(name.trim());
    const slug = await this.ensureUniqueSlug(slugBase);

    const company = await this.prisma.company.create({
      data: {
        name: name.trim(),
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

  async findAll(userId: string) {
    return this.prisma.company.findMany({
      where: {
        users: {
          some: { id: userId },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
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
