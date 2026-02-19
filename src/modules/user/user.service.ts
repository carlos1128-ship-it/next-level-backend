import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ChangePasswordDto } from './dto/change-password.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import * as bcrypt from 'bcrypt';

@Injectable()
export class UserService {
  constructor(private readonly prisma: PrismaService) {}

  async updateProfile(userId: string, dto: UpdateProfileDto) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
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
      },
      select: {
        id: true,
        email: true,
        name: true,
        detailLevel: true,
        companyId: true,
      },
    });

    return updated;
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

    const newHash = await bcrypt.hash(dto.newPassword, 10);
    await this.prisma.user.update({
      where: { id: userId },
      data: { password: newHash },
    });

    return { success: true };
  }
}
