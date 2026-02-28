import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import * as bcrypt from 'bcrypt';
import { createHash, randomUUID } from 'crypto';
import type { StringValue } from 'ms';
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
    private readonly configService: ConfigService,
  ) {}

  async login(dto: LoginDto) {
    const normalizedEmail = dto.email.toLowerCase().trim();
    const user = await this.prisma.user.findUnique({
      where: { email: normalizedEmail },
      include: { company: true },
    });

    if (!user) {
      throw new UnauthorizedException('Credenciais invalidas');
    }

    const isPasswordValid = await bcrypt.compare(dto.password, user.password || '');
    if (!isPasswordValid) {
      throw new UnauthorizedException('Credenciais invalidas');
    }

    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      companyId: user.companyId ?? undefined,
    };

    const tokens = await this.issueTokens(payload);

    return {
      ...tokens,
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
      throw new ConflictException('E-mail ja cadastrado');
    }

    const companySlug = dto.companySlug?.trim() || this.slugify(dto.companyName);
    const existingCompany = await this.prisma.company.findUnique({
      where: { slug: companySlug },
    });

    if (existingCompany) {
      throw new ConflictException('Slug da empresa ja esta em uso');
    }

    const passwordHash = await bcrypt.hash(dto.password, 10);
    const created = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email: dto.email.toLowerCase().trim(),
          password: passwordHash,
          name: dto.name?.trim() || 'Administrador',
        },
      });

      const company = await tx.company.create({
        data: {
          name: dto.companyName.trim(),
          slug: companySlug,
          userId: user.id,
        },
      });

      await tx.user.update({
        where: { id: user.id },
        data: { companyId: company.id },
      });

      return { company, user };
    });

    const payload: JwtPayload = {
      sub: created.user.id,
      email: created.user.email,
      companyId: created.company.id,
    };

    const tokens = await this.issueTokens(payload);

    return {
      ...tokens,
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

  async refresh(refreshToken: string) {
    const parsed = refreshToken?.trim();
    if (!parsed) {
      throw new UnauthorizedException('Refresh token ausente');
    }

    let payload: JwtPayload & { jti?: string; type?: string };
    try {
      payload = this.jwtService.verify(parsed, {
        secret: this.refreshTokenSecret,
      });
    } catch {
      throw new UnauthorizedException('Refresh token invalido');
    }

    if (payload.type !== 'refresh' || !payload.jti) {
      throw new UnauthorizedException('Refresh token invalido');
    }

    const tokenHash = this.hashToken(parsed);

    const storedToken = await this.prisma.refreshToken.findFirst({
      where: {
        userId: payload.sub,
        tokenHash,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
    });

    if (!storedToken) {
      throw new UnauthorizedException('Refresh token expirado ou revogado');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      include: { company: true },
    });

    if (!user) {
      throw new UnauthorizedException('Usuario nao encontrado');
    }

    await this.prisma.refreshToken.update({
      where: { id: storedToken.id },
      data: { revokedAt: new Date() },
    });

    const nextPayload: JwtPayload = {
      sub: user.id,
      email: user.email,
      companyId: user.companyId ?? undefined,
    };

    const tokens = await this.issueTokens(nextPayload);

    return {
      ...tokens,
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

  async logout(userId: string, refreshToken?: string) {
    if (!refreshToken?.trim()) {
      await this.prisma.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      return { success: true };
    }

    await this.prisma.refreshToken.updateMany({
      where: {
        userId,
        tokenHash: this.hashToken(refreshToken),
        revokedAt: null,
      },
      data: { revokedAt: new Date() },
    });

    return { success: true };
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

  private async issueTokens(payload: JwtPayload) {
    const accessToken = this.jwtService.sign(payload, {
      secret: this.accessTokenSecret,
      expiresIn: this.accessTokenExpiresIn as StringValue,
    });

    const refreshJti = randomUUID();
    const refreshToken = this.jwtService.sign(
      {
        ...payload,
        type: 'refresh',
        jti: refreshJti,
      },
      {
        secret: this.refreshTokenSecret,
        expiresIn: this.refreshTokenExpiresIn as StringValue,
      },
    );

    const refreshExpiresAt = new Date(
      Date.now() + this.parseDurationMs(this.refreshTokenExpiresIn),
    );

    await this.prisma.refreshToken.create({
      data: {
        userId: payload.sub,
        tokenHash: this.hashToken(refreshToken),
        expiresAt: refreshExpiresAt,
      },
    });

    return {
      access_token: accessToken,
      accessToken,
      refresh_token: refreshToken,
      refreshToken,
      expires_in: this.accessTokenExpiresIn,
    };
  }

  private hashToken(value: string) {
    return createHash('sha256').update(value).digest('hex');
  }

  private parseDurationMs(raw: string): number {
    const value = raw.trim().toLowerCase();
    const match = value.match(/^(\d+)(m|h|d)$/);
    if (!match) {
      return 30 * 24 * 60 * 60 * 1000;
    }

    const amount = Number(match[1]);
    const unit = match[2];

    if (unit === 'm') return amount * 60 * 1000;
    if (unit === 'h') return amount * 60 * 60 * 1000;
    return amount * 24 * 60 * 60 * 1000;
  }

  private get accessTokenSecret() {
    return this.configService.getOrThrow<string>('JWT_SECRET');
  }

  private get refreshTokenSecret() {
    return this.configService.get<string>('JWT_REFRESH_SECRET') || this.accessTokenSecret;
  }

  private get accessTokenExpiresIn() {
    return this.configService.get<string>('JWT_EXPIRES_IN') || '15m';
  }

  private get refreshTokenExpiresIn() {
    return this.configService.get<string>('JWT_REFRESH_EXPIRES_IN') || '30d';
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
