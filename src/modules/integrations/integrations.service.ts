import { BadRequestException, Injectable } from '@nestjs/common';
import { Integration, IntegrationProvider } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

export interface IntegrationStatus {
  provider: IntegrationProvider;
  status: string;
  connected: boolean;
  externalId: string | null;
  updatedAt: Date | null;
}

interface ConnectIntegrationInput {
  provider: IntegrationProvider;
  accessToken: string;
  externalId: string;
  status?: string;
  companyId?: string | null;
}

@Injectable()
export class IntegrationsService {
  constructor(private readonly prisma: PrismaService) {}

  async upsertIntegration(
    userId: string,
    data: ConnectIntegrationInput,
    companyId?: string | null,
  ): Promise<Integration> {
    const company = await this.resolveCompany(userId, companyId || data.companyId);
    const normalizedStatus = (data.status || 'connected').trim().toLowerCase();

    return this.prisma.integration.upsert({
      where: {
        companyId_provider: {
          companyId: company.id,
          provider: data.provider,
        },
      },
      update: {
        accessToken: data.accessToken.trim(),
        externalId: data.externalId.trim(),
        status: normalizedStatus,
      },
      create: {
        companyId: company.id,
        provider: data.provider,
        accessToken: data.accessToken.trim(),
        externalId: data.externalId.trim(),
        status: normalizedStatus,
      },
    });
  }

  async listStatuses(
    userId: string,
    companyId?: string | null,
  ): Promise<IntegrationStatus[]> {
    const company = await this.resolveCompany(userId, companyId);
    const integrations = await this.prisma.integration.findMany({
      where: { companyId: company.id },
    });

    const providers = Object.values(IntegrationProvider);
    return providers.map((provider) => {
      const current = integrations.find((item) => item.provider === provider);
      const status = current?.status || 'disconnected';
      return {
        provider,
        status,
        connected: Boolean(current) && status !== 'disconnected',
        externalId: current?.externalId ?? null,
        updatedAt: current?.updatedAt ?? null,
      };
    });
  }

  async findCompanyIdByExternalId(
    provider: IntegrationProvider,
    externalId: string | null | undefined,
  ): Promise<string | null> {
    if (!externalId) return null;

    const integration = await this.prisma.integration.findFirst({
      where: {
        provider,
        externalId: externalId.trim(),
      },
      select: { companyId: true, status: true },
    });

    if (!integration) return null;
    if (integration.status?.toLowerCase() === 'disconnected') return null;
    return integration.companyId;
  }

  async getActiveIntegration(
    companyId: string,
    provider: IntegrationProvider,
  ): Promise<Integration> {
    const integration = await this.prisma.integration.findFirst({
      where: {
        companyId,
        provider,
      },
    });

    if (!integration) {
      throw new BadRequestException(
        `${provider.toString()} nao configurado para esta empresa`,
      );
    }

    if (integration.status?.toLowerCase() === 'disconnected') {
      throw new BadRequestException(
        `${provider.toString()} desconectado para esta empresa`,
      );
    }

    return integration;
  }

  sanitize(integration: Integration) {
    const { accessToken: _accessToken, ...safe } = integration;
    return safe;
  }

  private async resolveCompany(
    userId: string,
    companyId?: string | null,
  ): Promise<{ id: string }> {
    const normalizedCompanyId = companyId?.trim();

    if (!normalizedCompanyId) {
      const owned = await this.prisma.company.findFirst({
        where: {
          OR: [{ userId }, { users: { some: { id: userId } } }],
        },
        select: { id: true },
      });
      if (owned?.id) return { id: owned.id };
      throw new BadRequestException('companyId nao informado');
    }

    const company = await this.prisma.company.findFirst({
      where: {
        id: normalizedCompanyId,
        OR: [{ userId }, { users: { some: { id: userId } } }],
      },
      select: { id: true },
    });

    if (!company) {
      throw new BadRequestException('Empresa invalida');
    }

    return company;
  }
}
