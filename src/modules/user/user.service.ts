import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ChangePasswordDto } from './dto/change-password.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import * as bcrypt from 'bcrypt';

const BCRYPT_ROUNDS = Number(process.env.BCRYPT_ROUNDS || 12);

type UserProfileRecord = {
  id: string;
  email: string;
  name: string | null;
  admin?: boolean | null;
  detailLevel?: string | null;
  niche?: string | null;
  companyId: string | null;
};

@Injectable()
export class UserService {
  constructor(private readonly prisma: PrismaService) {}

  async getProfile(userId: string) {
    const fieldAvailability = await this.resolveProfileFieldAvailability();
    const [user, companyCount] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        select: this.buildProfileSelect(fieldAvailability),
      }),
      this.prisma.company.count({
        where: {
          OR: [{ userId }, { users: { some: { id: userId } } }],
        },
      }),
    ]);

    if (!user) {
      throw new NotFoundException('Usuario nao encontrado');
    }

    const normalizedUser = this.normalizeProfileRecord(user as UserProfileRecord);

    return {
      ...normalizedUser,
      companyCount,
    };
  }

  async updateProfile(userId: string, dto: UpdateProfileDto) {
    const fieldAvailability = await this.resolveProfileFieldAvailability();
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        companyId: true,
      },
    });

    if (!user) {
      throw new NotFoundException('Usuario nao encontrado');
    }

    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: {
        name: dto.name?.trim(),
        ...(fieldAvailability.detailLevel && dto.detailLevel !== undefined
          ? { detailLevel: dto.detailLevel }
          : {}),
        ...(fieldAvailability.niche && dto.niche !== undefined ? { niche: dto.niche } : {}),
      },
      select: this.buildProfileSelect(fieldAvailability),
    });

    return this.normalizeProfileRecord(updated as UserProfileRecord);
  }

  async changePassword(userId: string, dto: ChangePasswordDto) {
    if (dto.currentPassword === dto.newPassword) {
      throw new BadRequestException(
        'A nova senha deve ser diferente da senha atual',
      );
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { password: true },
    });

    if (!user) {
      throw new NotFoundException('Usuario nao encontrado');
    }

    if (!user.password) {
      throw new BadRequestException(
        'Conta criada via Google. Use a opcao de login com Google.',
      );
    }

    const isValid = await bcrypt.compare(dto.currentPassword, user.password);
    if (!isValid) {
      throw new BadRequestException('Senha atual invalida');
    }

    const newHash = await bcrypt.hash(dto.newPassword, BCRYPT_ROUNDS);
    await this.prisma.user.update({
      where: { id: userId },
      data: { password: newHash },
    });

    return { success: true };
  }

  async deleteAccount(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });

    if (!user) {
      throw new NotFoundException('Usuario nao encontrado');
    }

    await this.prisma.$transaction([
      this.prisma.company.updateMany({
        where: { userId },
        data: { userId: null },
      }),
      this.prisma.user.delete({
        where: { id: userId },
      }),
    ]);

    return { success: true };
  }

  private async resolveProfileFieldAvailability() {
    const [admin, detailLevel, niche] = await Promise.all([
      this.prisma.hasColumn('User', 'admin'),
      this.prisma.hasColumn('User', 'detailLevel'),
      this.prisma.hasColumn('User', 'niche'),
    ]);

    return { admin, detailLevel, niche };
  }

  private buildProfileSelect(fieldAvailability: {
    admin: boolean;
    detailLevel: boolean;
    niche: boolean;
  }): Prisma.UserSelect {
    return {
      id: true,
      email: true,
      name: true,
      ...(fieldAvailability.admin ? { admin: true } : {}),
      ...(fieldAvailability.detailLevel ? { detailLevel: true } : {}),
      ...(fieldAvailability.niche ? { niche: true } : {}),
      companyId: true,
    };
  }

  private normalizeProfileRecord(user: UserProfileRecord) {
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
}
