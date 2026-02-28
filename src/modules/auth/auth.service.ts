import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../../prisma/prisma.service';
import * as bcrypt from 'bcrypt';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';

export interface JwtPayload {
  sub: string;
  email: string;
  companyId?: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
  ) {}

  async login(dto: LoginDto) {
    const normalizedEmail = dto.email.toLowerCase().trim();
    const user = await this.prisma.user.findUnique({
      where: { email: normalizedEmail },
      include: { company: true },
    });

    if (!user) {
      throw new UnauthorizedException('Credenciais inválidas');
    }

    const isPasswordValid = await bcrypt.compare(dto.password, user.password || '');
    if (!isPasswordValid) {
      throw new UnauthorizedException('Credenciais inválidas');
    }

    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      companyId: user.companyId ?? undefined,
    };

    const accessToken = this.jwtService.sign(payload);

    return {
      accessToken,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        detailLevel: user.detailLevel,
        companyId: user.companyId,
        companyName: user.company?.name ?? '',
      },
    };
  }

  async register(dto: RegisterDto) {
    const existingUser = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });

    if (existingUser) {
      throw new ConflictException('E-mail já cadastrado');
    }

    const companySlug = dto.companySlug?.trim() || this.slugify(dto.companyName);
    const existingCompany = await this.prisma.company.findUnique({
      where: { slug: companySlug },
    });

    if (existingCompany) {
      throw new ConflictException('Slug da empresa já está em uso');
    }

    const passwordHash = await bcrypt.hash(dto.password, 10);
    const created = await this.prisma.$transaction(async (tx) => {
      const company = await tx.company.create({
        data: {
          name: dto.companyName.trim(),
          slug: companySlug,
        },
      });

      const user = await tx.user.create({
        data: {
          email: dto.email.toLowerCase().trim(),
          password: passwordHash,
          name: dto.name?.trim() || 'Administrador',
          companyId: company.id,
        },
      });

      return { company, user };
    });

    const payload: JwtPayload = {
      sub: created.user.id,
      email: created.user.email,
      companyId: created.company.id,
    };

    return {
      accessToken: this.jwtService.sign(payload),
      user: {
        id: created.user.id,
        email: created.user.email,
        name: created.user.name,
        detailLevel: created.user.detailLevel,
        companyId: created.company.id,
        companyName: created.company.name,
      },
    };
  }

  async validateUser(payload: JwtPayload) {
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      include: { company: true },
    });
    if (!user) return null;
    return {
      id: user.id,
      email: user.email,
      companyId: user.companyId ?? undefined,
      detailLevel: user.detailLevel,
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
}
