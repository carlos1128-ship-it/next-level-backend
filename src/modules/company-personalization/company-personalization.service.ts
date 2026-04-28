import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { UserNiche } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  buildPersonalizationRecommendations,
  COMPANY_MODULES,
  isKnownModuleKey,
  normalizeBusinessType,
  PersonalizationProfileInput,
  PersonalizationRecommendations,
} from './business-personalization.registry';
import {
  DASHBOARD_METRIC_KEYS,
  DASHBOARD_METRICS,
} from '../dashboard/dashboard-metrics.registry';
import type { JwtPayload } from '../../common/decorators/current-user.decorator';

export type OnboardingPayload = PersonalizationProfileInput & {
  applyRecommendedSetup?: boolean;
  overwriteAgentConfig?: boolean;
  onboardingSkipped?: boolean;
};

export type ModulePreferenceInput = {
  moduleKey?: string;
  enabled?: boolean;
  order?: number;
  source?: string | null;
};

type CompanyContext = {
  companyId: string;
  companyName: string;
  companyCreatedAt: Date;
  isAdmin: boolean;
};

const ESSENTIAL_MODULE_KEYS = new Set(['dashboard', 'settings', 'profile', 'plans', 'companies']);

@Injectable()
export class CompanyPersonalizationService {
  constructor(private readonly prisma: PrismaService) {}

  async getStatus(user: JwtPayload, requestedCompanyId?: string) {
    const context = await this.resolveCompanyContext(user, requestedCompanyId, {
      allowMissingCompany: true,
    });

    if (!context) {
      return {
        onboardingCompleted: true,
        onboardingSkipped: false,
        profile: null,
        shouldRedirectToOnboarding: false,
        shouldShowPersonalizationBanner: false,
        hasActivePlan: false,
        legacyCompany: false,
      };
    }

    const [profile, hasBusinessData, userPlan] = await Promise.all([
      this.prisma.companyProfile.findUnique({
        where: { companyId: context.companyId },
      }),
      this.companyHasBusinessData(context.companyId),
      this.prisma.user.findUnique({
        where: { id: user.sub },
        select: { plan: true },
      }),
    ]);

    const hasActivePlan = Boolean(userPlan?.plan);
    const onboardingCompleted = Boolean(profile?.onboardingCompleted);
    const onboardingSkipped = Boolean(profile?.onboardingSkipped);
    const legacyCompany = !profile && this.isLegacyCompany(context.companyCreatedAt);
    const shouldRedirectToOnboarding =
      hasActivePlan &&
      !context.isAdmin &&
      !onboardingCompleted &&
      !onboardingSkipped &&
      !(legacyCompany || hasBusinessData);

    return {
      onboardingCompleted,
      onboardingSkipped,
      profile,
      shouldRedirectToOnboarding,
      shouldShowPersonalizationBanner:
        hasActivePlan && !onboardingCompleted && !onboardingSkipped && (legacyCompany || hasBusinessData),
      hasActivePlan,
      legacyCompany,
    };
  }

  async getPersonalization(user: JwtPayload, requestedCompanyId?: string) {
    const context = await this.resolveCompanyContext(user, requestedCompanyId);
    const [profile, modulePreferences, dashboardPreferences, agentConfig] =
      await Promise.all([
        this.prisma.companyProfile.findUnique({
          where: { companyId: context.companyId },
        }),
        this.getResolvedModulePreferences(context.companyId),
        this.getResolvedDashboardPreferences(context.companyId),
        this.prisma.agentConfig.findUnique({
          where: { companyId: context.companyId },
        }),
      ]);

    return {
      profile,
      modulePreferences,
      dashboardPreferences,
      agentConfig,
      recommendations: profile
        ? buildPersonalizationRecommendations(profile, context.companyName)
        : null,
    };
  }

  async saveOnboarding(
    user: JwtPayload,
    payload: OnboardingPayload,
    requestedCompanyId?: string,
  ) {
    const context = await this.resolveCompanyContext(user, requestedCompanyId);
    const profileInput = this.normalizeProfileInput(payload);
    const businessType = normalizeBusinessType(profileInput.businessType);
    const profileData = {
      ...profileInput,
      businessType,
      onboardingCompleted: true,
      onboardingSkipped: Boolean(payload.onboardingSkipped),
      completedAt: new Date(),
    };

    const profile = await this.prisma.companyProfile.upsert({
      where: { companyId: context.companyId },
      update: profileData,
      create: {
        companyId: context.companyId,
        ...profileData,
      },
    });

    const recommendations = buildPersonalizationRecommendations(profile, context.companyName);
    let appliedSetup = null;
    if (payload.applyRecommendedSetup !== false) {
      appliedSetup = await this.applyRecommendations(
        context.companyId,
        context.companyName,
        recommendations,
        Boolean(payload.overwriteAgentConfig),
      );
    }

    await this.syncUserNicheIfEmpty(user.sub, businessType);

    return {
      profile,
      recommendations,
      appliedSetup,
      modulePreferences: await this.getResolvedModulePreferences(context.companyId),
      dashboardPreferences: await this.getResolvedDashboardPreferences(context.companyId),
      agentConfig: await this.prisma.agentConfig.findUnique({
        where: { companyId: context.companyId },
      }),
      userNiche: this.mapBusinessTypeToUserNiche(businessType),
    };
  }

  async previewRecommendations(
    user: JwtPayload,
    payload: PersonalizationProfileInput,
    requestedCompanyId?: string,
  ) {
    const context = await this.resolveCompanyContext(user, requestedCompanyId);
    const input = this.normalizeProfileInput(payload);
    return {
      recommendations: buildPersonalizationRecommendations(input, context.companyName),
    };
  }

  async updateProfile(
    user: JwtPayload,
    payload: PersonalizationProfileInput,
    requestedCompanyId?: string,
  ) {
    const context = await this.resolveCompanyContext(user, requestedCompanyId);
    const existing = await this.prisma.companyProfile.findUnique({
      where: { companyId: context.companyId },
    });
    const input = this.normalizeProfileInput(payload);
    const profile = await this.prisma.companyProfile.upsert({
      where: { companyId: context.companyId },
      update: input,
      create: {
        companyId: context.companyId,
        ...input,
        onboardingCompleted: existing?.onboardingCompleted ?? false,
        onboardingSkipped: existing?.onboardingSkipped ?? false,
        completedAt: existing?.completedAt ?? null,
      },
    });

    return {
      profile,
      recommendations: buildPersonalizationRecommendations(profile, context.companyName),
    };
  }

  async saveModulePreferences(
    user: JwtPayload,
    payload: ModulePreferenceInput[],
    requestedCompanyId?: string,
  ) {
    const context = await this.resolveCompanyContext(user, requestedCompanyId);
    if (!Array.isArray(payload)) {
      throw new BadRequestException('preferences deve ser uma lista');
    }

    const normalized = payload.map((item, index) => {
      const moduleKey = String(item?.moduleKey || '').trim();
      if (!isKnownModuleKey(moduleKey)) {
        throw new BadRequestException(`Modulo desconhecido: ${moduleKey || '(vazio)'}`);
      }
      return {
        moduleKey,
        enabled: Boolean(item.enabled),
        order: Number.isFinite(Number(item.order)) ? Number(item.order) : index,
        source: item.source?.trim() || 'manual',
      };
    });

    await this.prisma.$transaction(
      normalized.map((item) =>
        this.prisma.companyModulePreference.upsert({
          where: {
            companyId_moduleKey: {
              companyId: context.companyId,
              moduleKey: item.moduleKey,
            },
          },
          update: {
            enabled: item.enabled,
            order: item.order,
            source: item.source,
          },
          create: {
            companyId: context.companyId,
            moduleKey: item.moduleKey,
            enabled: item.enabled,
            order: item.order,
            source: item.source,
          },
        }),
      ),
    );

    return {
      modulePreferences: await this.getResolvedModulePreferences(context.companyId),
    };
  }

  async resetRecommendations(user: JwtPayload, requestedCompanyId?: string) {
    const context = await this.resolveCompanyContext(user, requestedCompanyId);
    const profile = await this.prisma.companyProfile.findUnique({
      where: { companyId: context.companyId },
    });

    if (!profile) {
      throw new BadRequestException('Perfil da empresa ainda nao foi criado');
    }

    const recommendations = buildPersonalizationRecommendations(profile, context.companyName);
    const appliedSetup = await this.applyRecommendations(
      context.companyId,
      context.companyName,
      recommendations,
      false,
    );

    return {
      profile,
      recommendations,
      appliedSetup,
      modulePreferences: await this.getResolvedModulePreferences(context.companyId),
      dashboardPreferences: await this.getResolvedDashboardPreferences(context.companyId),
      agentConfig: await this.prisma.agentConfig.findUnique({
        where: { companyId: context.companyId },
      }),
    };
  }

  private async applyRecommendations(
    companyId: string,
    companyName: string,
    recommendations: PersonalizationRecommendations,
    overwriteAgentConfig: boolean,
  ) {
    const enabledModules = new Set(recommendations.modules);
    const enabledMetrics = new Set(
      recommendations.dashboardMetrics.filter((metric) => DASHBOARD_METRIC_KEYS.has(metric)),
    );

    await this.prisma.$transaction([
      this.prisma.companyModulePreference.deleteMany({ where: { companyId } }),
      this.prisma.companyModulePreference.createMany({
        data: COMPANY_MODULES.map((module) => ({
          companyId,
          moduleKey: module.key,
          enabled: enabledModules.has(module.key) || ESSENTIAL_MODULE_KEYS.has(module.key),
          order: module.order,
          source: 'onboarding',
        })),
      }),
      this.prisma.dashboardPreference.deleteMany({
        where: { companyId, userId: null },
      }),
      this.prisma.dashboardPreference.createMany({
        data: DASHBOARD_METRICS.map((metric, index) => ({
          companyId,
          userId: null,
          metricKey: metric.key,
          enabled: enabledMetrics.has(metric.key),
          order: index,
          size: metric.displayType === 'chart' ? 'large' : 'small',
        })),
      }),
    ]);

    const agentConfig = await this.applyAgentRecommendation(
      companyId,
      companyName,
      recommendations,
      overwriteAgentConfig,
    );

    return {
      modulesApplied: COMPANY_MODULES.length,
      dashboardMetricsApplied: DASHBOARD_METRICS.length,
      enabledModules: Array.from(enabledModules),
      enabledDashboardMetrics: Array.from(enabledMetrics),
      agentConfig,
    };
  }

  private async applyAgentRecommendation(
    companyId: string,
    companyName: string,
    recommendations: PersonalizationRecommendations,
    overwriteAgentConfig: boolean,
  ) {
    const existing = await this.prisma.agentConfig.findUnique({
      where: { companyId },
    });

    if (existing && !overwriteAgentConfig) {
      return {
        applied: false,
        reason: 'existing_agent_config_preserved',
        id: existing.id,
      };
    }

    const data = {
      agentName: 'Atendente Next Level',
      companyDescription: companyName,
      tone: recommendations.agent.tone,
      toneOfVoice: recommendations.agent.toneOfVoice,
      welcomeMessage: recommendations.agent.welcomeMessage,
      instructions: recommendations.agent.safetyBoundaries.join('\n'),
      systemPrompt: recommendations.agent.systemPrompt,
      internetSearchEnabled: recommendations.agent.internetSearchEnabled,
      speechToTextEnabled: recommendations.agent.audioToTextEnabled,
      imageUnderstandingEnabled: recommendations.agent.imageReadingEnabled,
      pauseForHuman: recommendations.agent.humanPauseEnabled,
      debounceSeconds: recommendations.agent.debounceSeconds,
      maxContextMessages: recommendations.agent.maxContextMessages,
      splitRepliesEnabled: recommendations.agent.splitResponsesEnabled,
      messageBufferEnabled: recommendations.agent.bufferEnabled,
      isEnabled: recommendations.agent.attendantActive,
      modelProvider: 'openai',
      modelName: 'gpt-4o-mini',
      isOnline: true,
    };

    const saved = await this.prisma.agentConfig.upsert({
      where: { companyId },
      update: data,
      create: {
        companyId,
        ...data,
      },
    });

    return {
      applied: true,
      id: saved.id,
    };
  }

  private async getResolvedModulePreferences(companyId: string) {
    const persisted = await this.prisma.companyModulePreference.findMany({
      where: { companyId },
      select: {
        moduleKey: true,
        enabled: true,
        source: true,
        order: true,
      },
    });
    const byKey = new Map(persisted.map((item) => [item.moduleKey, item]));

    return COMPANY_MODULES.map((module) => {
      const saved = byKey.get(module.key);
      return {
        ...module,
        moduleKey: module.key,
        enabled: saved?.enabled ?? module.defaultEnabled,
        source: saved?.source ?? 'system',
        order: saved?.order ?? module.order,
      };
    }).sort((a, b) => a.order - b.order);
  }

  private async getResolvedDashboardPreferences(companyId: string) {
    const persisted = await this.prisma.dashboardPreference.findMany({
      where: { companyId, userId: null },
      select: {
        metricKey: true,
        enabled: true,
        order: true,
        size: true,
      },
    });
    const byKey = new Map(persisted.map((item) => [item.metricKey, item]));

    return DASHBOARD_METRICS.map((metric, index) => {
      const saved = byKey.get(metric.key);
      return {
        metricKey: metric.key,
        enabled: saved?.enabled ?? metric.defaultEnabled,
        order: saved?.order ?? index,
        size: saved?.size ?? null,
      };
    }).sort((a, b) => a.order - b.order);
  }

  private normalizeProfileInput(payload: PersonalizationProfileInput) {
    return {
      businessType: normalizeBusinessType(payload.businessType),
      businessModel: this.optionalString(payload.businessModel),
      mainGoal: this.optionalString(payload.mainGoal),
      salesChannel: this.optionalString(payload.salesChannel),
      companySize: this.optionalString(payload.companySize),
      monthlyRevenueRange: this.optionalString(payload.monthlyRevenueRange),
      dataMaturity: this.optionalString(payload.dataMaturity),
      usesPaidTraffic: Boolean(payload.usesPaidTraffic),
      hasPhysicalProducts: Boolean(payload.hasPhysicalProducts),
      hasDigitalProducts: Boolean(payload.hasDigitalProducts),
      hasServices: Boolean(payload.hasServices),
      usesWhatsAppForSales: Boolean(payload.usesWhatsAppForSales),
      usesMarketplace: Boolean(payload.usesMarketplace),
      hasSupportTeam: Boolean(payload.hasSupportTeam),
      hasOperationalCosts: Boolean(payload.hasOperationalCosts),
      wantsAutomation: Boolean(payload.wantsAutomation),
      wantsMarketAnalysis: Boolean(payload.wantsMarketAnalysis),
    };
  }

  private optionalString(value?: string | null) {
    const normalized = String(value || '').trim();
    return normalized || null;
  }

  private async resolveCompanyContext(
    user: JwtPayload,
    requestedCompanyId: string | undefined,
    options: { allowMissingCompany: true },
  ): Promise<CompanyContext | null>;
  private async resolveCompanyContext(
    user: JwtPayload,
    requestedCompanyId?: string,
    options?: { allowMissingCompany?: false },
  ): Promise<CompanyContext>;
  private async resolveCompanyContext(
    user: JwtPayload,
    requestedCompanyId?: string,
    options?: { allowMissingCompany?: boolean },
  ): Promise<CompanyContext | null> {
    const userId = user?.sub;
    if (!userId) {
      throw new ForbiddenException('Usuario nao autenticado');
    }

    const requested = requestedCompanyId?.trim() || user.companyId || '';
    if (!requested) {
      if (options?.allowMissingCompany) return null;
      throw new BadRequestException('companyId nao informado');
    }

    const company = await this.prisma.company.findFirst({
      where: {
        id: requested,
        ...(user.admin
          ? {}
          : { OR: [{ userId }, { users: { some: { id: userId } } }] }),
      },
      select: {
        id: true,
        name: true,
        createdAt: true,
      },
    });

    if (!company) {
      if (options?.allowMissingCompany) return null;
      throw new ForbiddenException('Sem acesso a empresa informada');
    }

    return {
      companyId: company.id,
      companyName: company.name,
      companyCreatedAt: company.createdAt,
      isAdmin: Boolean(user.admin),
    };
  }

  private async companyHasBusinessData(companyId: string) {
    const [
      sales,
      products,
      customers,
      costs,
      transactions,
      connections,
      agentConfigs,
    ] = await Promise.all([
      this.prisma.sale.count({ where: { companyId } }),
      this.prisma.product.count({ where: { companyId } }),
      this.prisma.customer.count({ where: { companyId } }),
      this.prisma.operationalCost.count({ where: { companyId } }),
      this.prisma.financialTransaction.count({ where: { companyId } }),
      this.prisma.whatsappConnection.count({ where: { companyId } }),
      this.prisma.agentConfig.count({ where: { companyId } }),
    ]);

    return sales + products + customers + costs + transactions + connections + agentConfigs > 0;
  }

  private isLegacyCompany(createdAt: Date) {
    const raw = process.env.ONBOARDING_ENFORCEMENT_START || '2026-04-28T00:00:00.000Z';
    const enforcementStart = new Date(raw);
    if (Number.isNaN(enforcementStart.getTime())) return false;
    return createdAt < enforcementStart;
  }

  private async syncUserNicheIfEmpty(userId: string, businessType: string) {
    const niche = this.mapBusinessTypeToUserNiche(businessType);
    if (!niche) return;

    await this.prisma.user.updateMany({
      where: {
        id: userId,
        niche: null,
      },
      data: {
        niche,
      },
    });
  }

  private mapBusinessTypeToUserNiche(businessType: string): UserNiche {
    if (['ecommerce_physical', 'ecommerce_digital', 'retail_store', 'marketplace_seller', 'restaurant'].includes(businessType)) {
      return UserNiche.ECOMMERCE;
    }
    if (businessType === 'medical_clinic') {
      return UserNiche.MEDICINA;
    }
    if (['agency', 'local_services', 'law_office', 'saas'].includes(businessType)) {
      return UserNiche.SERVICOS;
    }
    return UserNiche.OUTROS;
  }
}
