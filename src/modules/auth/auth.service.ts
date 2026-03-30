import { ConflictException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import * as bcrypt from 'bcrypt';
import { createHash, randomUUID } from 'crypto';
import type { StringValue } from 'ms';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';

const BCRYPT_ROUNDS = Number(process.env.BCRYPT_ROUNDS || 12);

export interface JwtPayload {
  sub: string;
  email: string;
  companyId?: string;
  admin?: boolean;
  niche?: string;
}

type AuthUserRecord = {
  id: string;
  email: string;
  password?: string;
  name: string | null;
  admin?: boolean | null;
  detailLevel?: string | null;
  niche?: string | null;
  companyId: string | null;
  company?: {
    id: string;
    name: string;
  } | null;
};

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  async login(dto: LoginDto) {
    const normalizedEmail = dto.email.toLowerCase().trim();
    const user = await this.findUserForLogin(normalizedEmail);

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
      admin: Boolean(user.admin),
    };

    const tokens = await this.issueTokens(payload);

    return {
      ...tokens,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        admin: Boolean(user.admin),
        detailLevel: user.detailLevel,
        niche: user.niche ?? null,
        companyId: user.companyId,
        companyName: user.company?.name ?? '',
      },
    };
  }

  async register(dto: RegisterDto) {
    const fieldAvailability = await this.resolveUserFieldAvailability();
    const existingUser = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });

    if (existingUser) {
      throw new ConflictException('E-mail ja cadastrado');
    }

    const companySlug = dto.companySlug?.trim() || this.slugify(dto.companyName);
    const existingCompany = await this.prisma.company.findUnique({
      where: { slug: companySlug },
      select: { id: true },
    });

    if (existingCompany) {
      throw new ConflictException('Slug da empresa ja esta em uso');
    }

    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);
    const created = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email: dto.email.toLowerCase().trim(),
          password: passwordHash,
          name: dto.name?.trim() || 'Administrador',
          ...(fieldAvailability.admin ? { admin: false } : {}),
        },
        select: this.buildUserSelect({
          includePassword: false,
          includeCompany: false,
          fieldAvailability,
        }),
      });

      const company = await tx.company.create({
        data: {
          name: dto.companyName.trim(),
          slug: companySlug,
          userId: user.id,
        },
      });

      const updatedUser = await tx.user.update({
        where: { id: user.id },
        data: { companyId: company.id },
        select: this.buildUserSelect({
          includePassword: false,
          includeCompany: false,
          fieldAvailability,
        }),
      });

      return { company, user: updatedUser as AuthUserRecord };
    });

    const payload: JwtPayload = {
      sub: created.user.id,
      email: created.user.email,
      companyId: created.company.id,
      admin: Boolean(created.user.admin),
    };

    const tokens = await this.issueTokens(payload);

    return {
      ...tokens,
      user: {
        id: created.user.id,
        email: created.user.email,
        name: created.user.name,
        admin: Boolean(created.user.admin),
        detailLevel: created.user.detailLevel,
        niche: created.user.niche ?? null,
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

    const user = await this.findUserById(payload.sub, {
      includePassword: true,
      includeCompany: true,
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
      admin: Boolean(user.admin),
    };

    const tokens = await this.issueTokens(nextPayload);

    return {
      ...tokens,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        admin: Boolean(user.admin),
        detailLevel: user.detailLevel,
        niche: user.niche ?? null,
        companyId: user.companyId,
        companyName: user.company?.name ?? '',
      },
    };
  }

  async logout(userId?: string, refreshToken?: string) {
    if (!refreshToken?.trim()) {
      if (!userId) {
        return { success: true };
      }
      await this.prisma.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      return { success: true };
    }

    await this.prisma.refreshToken.updateMany({
      where: {
        ...(userId ? { userId } : {}),
        tokenHash: this.hashToken(refreshToken),
        revokedAt: null,
      },
      data: { revokedAt: new Date() },
    });

    return { success: true };
  }

  async validateUser(payload: JwtPayload) {
    const user = await this.findUserById(payload.sub, {
      includePassword: false,
      includeCompany: false,
    });
    if (!user) return null;
    return {
      id: user.id,
      email: user.email,
      companyId: user.companyId ?? undefined,
      admin: Boolean(user.admin),
      detailLevel: user.detailLevel,
      niche: user.niche ?? undefined,
    };
  }

  private async resolveUserFieldAvailability() {
    const [admin, detailLevel, niche] = await Promise.all([
      this.prisma.hasColumn('User', 'admin'),
      this.prisma.hasColumn('User', 'detailLevel'),
      this.prisma.hasColumn('User', 'niche'),
    ]);

    return { admin, detailLevel, niche };
  }

  private buildUserSelect(options: {
    includePassword: boolean;
    includeCompany: boolean;
    fieldAvailability: {
      admin: boolean;
      detailLevel: boolean;
      niche: boolean;
    };
  }): Prisma.UserSelect {
    return {
      id: true,
      email: true,
      ...(options.includePassword ? { password: true } : {}),
      name: true,
      ...(options.fieldAvailability.admin ? { admin: true } : {}),
      ...(options.fieldAvailability.detailLevel ? { detailLevel: true } : {}),
      ...(options.fieldAvailability.niche ? { niche: true } : {}),
      companyId: true,
      ...(options.includeCompany
        ? {
            company: {
              select: {
                id: true,
                name: true,
              },
            },
          }
        : {}),
    };
  }

  private async findUserForLogin(email: string) {
    const fieldAvailability = await this.resolveUserFieldAvailability();
    const user = (await this.prisma.user.findUnique({
      where: { email },
      select: this.buildUserSelect({
        includePassword: true,
        includeCompany: true,
        fieldAvailability,
      }),
    })) as AuthUserRecord | null;

    return this.normalizeAuthUserRecord(user);
  }

  private async findUserById(
    userId: string,
    options: { includePassword: boolean; includeCompany: boolean },
  ) {
    const fieldAvailability = await this.resolveUserFieldAvailability();
    const user = (await this.prisma.user.findUnique({
      where: { id: userId },
      select: this.buildUserSelect({
        ...options,
        fieldAvailability,
      }),
    })) as AuthUserRecord | null;

    return this.normalizeAuthUserRecord(user);
  }

  private normalizeAuthUserRecord(user: AuthUserRecord | null): AuthUserRecord | null {
    if (!user) {
      return null;
    }

    return {
      ...user,
      admin: Boolean(user.admin),
      detailLevel:
        typeof user.detailLevel === 'string' && user.detailLevel.trim()
          ? user.detailLevel
          : 'medium',
      niche: user.niche ?? null,
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

    const refreshTokenStored = await this.persistRefreshToken(
      payload.sub,
      refreshToken,
      refreshExpiresAt,
    );

    return {
      access_token: accessToken,
      accessToken,
      refresh_token: refreshTokenStored ? refreshToken : undefined,
      refreshToken: refreshTokenStored ? refreshToken : undefined,
      expires_in: this.accessTokenExpiresIn,
    };
  }

  private async persistRefreshToken(
    userId: string,
    refreshToken: string,
    refreshExpiresAt: Date,
  ): Promise<boolean> {
    try {
      await this.prisma.refreshToken.create({
        data: {
          userId,
          tokenHash: this.hashToken(refreshToken),
          expiresAt: refreshExpiresAt,
        },
      });
      return true;
    } catch (error) {
      if (this.isRecoverableRefreshTokenStorageError(error)) {
        this.logger.warn(
          'Refresh token storage unavailable. Login will continue with access token only.',
        );
        return false;
      }
      throw error;
    }
  }

  private isRecoverableRefreshTokenStorageError(error: unknown): boolean {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      return error.code === 'P2021' || error.code === 'P2022';
    }

    if (error instanceof Prisma.PrismaClientInitializationError) {
      return true;
    }

    if (error instanceof Error) {
      const message = error.message.toLowerCase();
      return (
        message.includes('refreshtoken') &&
        (message.includes('does not exist') ||
          message.includes('column') ||
          message.includes('relation'))
      );
    }

    return false;
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
