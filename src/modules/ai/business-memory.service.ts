import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class BusinessMemoryService {
  constructor(private readonly prisma: PrismaService) {}

  async remember(
    companyId: string,
    key: string,
    value: string,
    category = 'general',
    confidence = 1,
    metadataJson?: Record<string, unknown>,
  ) {
    return this.prisma.businessMemory.upsert({
      where: { companyId_key: { companyId, key } },
      update: { value, category, confidence, metadataJson: this.toJson(metadataJson) },
      create: { companyId, key, value, category, confidence, metadataJson: this.toJson(metadataJson) },
    });
  }

  async getCompanyMemory(companyId: string, category?: string, limit = 30) {
    return this.prisma.businessMemory.findMany({
      where: {
        companyId,
        ...(category ? { category } : {}),
      },
      orderBy: { updatedAt: 'desc' },
      take: limit,
    });
  }

  private toJson(value?: Record<string, unknown>) {
    return value ? (value as Prisma.InputJsonObject) : undefined;
  }
}
