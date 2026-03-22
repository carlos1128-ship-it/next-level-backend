import { BadRequestException, Injectable } from '@nestjs/common';
import { Integration, IntegrationProvider, WebhookLogStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { MetaGraphService } from './meta-graph.service';

export interface IntegrationStatus {
  provider: IntegrationProvider;
  status: string;
  connected: boolean;
  externalId: string | null;
  updatedAt: Date | null;
}

export interface ProviderDiagnosticStatus {
  status: 'ACTIVE' | 'INACTIVE' | 'DORMANT';
  lastEventReceived: string | null;
}

interface ConnectIntegrationInput {
  provider: IntegrationProvider;
  accessToken: string;
  externalId?: string;
  status?: string;
  companyId?: string | null;
}

@Injectable()
export class IntegrationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly metaGraphService: MetaGraphService,
  ) {}

  async upsertIntegration(
    userId: string,
    data: ConnectIntegrationInput,
    companyId?: string | null,
  ): Promise<Integration> {
    const company = await this.resolveCompany(userId, companyId || data.companyId);
    const normalizedStatus = (data.status || 'connected').trim().toLowerCase();
    const trimmedToken = data.accessToken.trim();
    let externalId = data.externalId?.trim();

    if (data.provider === IntegrationProvider.WHATSAPP) {
      const discovered = await this.metaGraphService.discoverWhatsappBusiness(trimmedToken);
      externalId = discovered.phoneNumberId;

      await this.prisma.company.update({
        where: { id: company.id },
        data: {
          metaPhoneNumberId: discovered.phoneNumberId,
          metaWabaId: discovered.wabaId,
        },
      });
    }

    if (!externalId) {
      throw new BadRequestException('externalId nao informado');
    }

    return this.prisma.integration.upsert({
      where: {
        companyId_provider: {
          companyId: company.id,
          provider: data.provider,
        },
      },
      update: {
        accessToken: trimmedToken,
        externalId,
        status: normalizedStatus,
      },
      create: {
        companyId: company.id,
        provider: data.provider,
        accessToken: trimmedToken,
        externalId,
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

  async getProviderDiagnostic(
    userId: string,
    providerInput: string,
    companyId?: string | null,
  ): Promise<ProviderDiagnosticStatus> {
    const company = await this.resolveCompany(userId, companyId);
    const provider = this.parseProvider(providerInput);
    const lastSuccess = await this.prisma.webhookLog.findFirst({
      where: {
        companyId: company.id,
        provider,
        status: WebhookLogStatus.SUCCESS,
      },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });

    if (!lastSuccess) {
      return {
        status: 'INACTIVE',
        lastEventReceived: null,
      };
    }

    const now = Date.now();
    const diffMs = now - lastSuccess.createdAt.getTime();
    const oneHourMs = 60 * 60 * 1000;

    return {
      status: diffMs > oneHourMs ? 'DORMANT' : 'ACTIVE',
      lastEventReceived: lastSuccess.createdAt.toISOString(),
    };
  }

  sanitize(integration: Integration) {
    const { accessToken: _accessToken, ...safe } = integration;
    return safe;
  }

  private parseProvider(raw: string) {
    const normalized = raw.trim().toLowerCase();
    if (['meta', 'whatsapp'].includes(normalized)) return IntegrationProvider.WHATSAPP;
    if (['instagram'].includes(normalized)) return IntegrationProvider.INSTAGRAM;
    if (['mercadolivre', 'mercado-livre', 'mercado_livre', 'ml'].includes(normalized)) {
      return IntegrationProvider.MERCADOLIVRE;
    }

    throw new BadRequestException('Provedor invalido');
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
