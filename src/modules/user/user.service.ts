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
  admin: boolean;
  detailLevel: string;
  niche?: string | null;
  companyId: string | null;
};

@Injectable()
export class UserService {
  constructor(private readonly prisma: PrismaService) {}

  async getProfile(userId: string) {
    const includeNiche = await this.hasUserNicheColumn();
    const [user, companyCount] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        select: this.buildProfileSelect(includeNiche),
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

    return {
      ...user,
      niche: user.niche ?? null,
      companyCount,
    };
  }

  async updateProfile(userId: string, dto: UpdateProfileDto) {
    const includeNiche = await this.hasUserNicheColumn();
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        admin: true,
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
        detailLevel: dto.detailLevel,
        ...(includeNiche && dto.niche !== undefined ? { niche: dto.niche } : {}),
      },
      select: this.buildProfileSelect(includeNiche),
    });

    return {
      ...updated,
      niche: updated.niche ?? null,
    };
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

  private async hasUserNicheColumn() {
    return this.prisma.hasColumn('User', 'niche');
  }

  private buildProfileSelect(includeNiche: boolean): Prisma.UserSelect {
    return {
      id: true,
      email: true,
      name: true,
      admin: true,
      detailLevel: true,
      ...(includeNiche ? { niche: true } : {}),
      companyId: true,
    };
  }
}
