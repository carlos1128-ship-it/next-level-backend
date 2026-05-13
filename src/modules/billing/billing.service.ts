import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BillingCycle, Plan, Prisma, SubscriptionStatus } from '@prisma/client';
import { createHmac, timingSafeEqual } from 'crypto';
import { Request } from 'express';
import { PrismaService } from '../../prisma/prisma.service';
import {
  ACTIVE_SUBSCRIPTION_STATUSES,
  BillingPlanKey,
  LEGACY_PLAN_BY_BILLING_KEY,
  PLAN_LEVELS,
  normalizeBillingPlanKey,
} from './constants/billing.constants';
import { CaktoProvider } from './providers/cakto/cakto.provider';
import { BillingWebhookEvent } from './providers/payment-provider.adapter';
import { PaymentProviderResolver } from './providers/payment-provider.resolver';

type AuthUser = {
  id?: string;
  userId?: string;
  sub?: string;
  companyId?: string | null;
  admin?: boolean;
};

type InternalGrantSource = 'INTERNAL_LEGACY' | 'MANUAL_GRANT' | 'ADMIN_GRANT';

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly paymentProviderResolver: PaymentProviderResolver,
    private readonly caktoProvider: CaktoProvider,
  ) {}

  async getBillingForUser(userId: string, companyId?: string | null) {
    const scopedCompanyId = await this.resolveCompanyIdForUser(userId, companyId, null);
    const subscription = await this.ensureEntitledSubscriptionForUser(userId, scopedCompanyId);
    const hasActiveSubscription = this.isSubscriptionActive(subscription);
    return {
      hasActiveSubscription,
      subscription: subscription
        ? {
            id: subscription.id,
            planKey: subscription.planKey,
            billingCycle: subscription.billingCycle,
            status: subscription.status,
            provider: subscription.provider,
            source: subscription.source,
            currentPeriodEnd: subscription.currentPeriodEnd,
            expiresAt: subscription.expiresAt,
          }
        : null,
    };
  }

  async getBillingConfig() {
    const provider = this.paymentProviderResolver.activeProviderKey;
    const adapter = this.paymentProviderResolver.resolve(provider);
    const checkoutEnabled = provider === 'CAKTO' && adapter.isCheckoutEnabled();
    const backendUrl = (
      this.configService.get<string>('BACKEND_URL') ||
      this.configService.get<string>('PUBLIC_API_URL') ||
      this.configService.get<string>('APP_URL') ||
      'http://localhost:3333'
    ).replace(/\/+$/, '');

    return {
      paymentProvider: provider,
      checkoutEnabled,
      message: checkoutEnabled ? null : 'Gateway de pagamento temporariamente indisponivel.',
      webhookUrl: provider === 'CAKTO' ? `${backendUrl}/api/billing/webhooks/cakto` : null,
    };
  }

  async createCheckout(
    user: AuthUser,
    input: { planKey: string; billingCycle: BillingCycle; companyId?: string | null },
  ) {
    const userId = this.resolveUserId(user);
    const planKey = normalizeBillingPlanKey(input.planKey);
    if (!planKey) {
      throw new BadRequestException({ code: 'INVALID_PLAN', message: 'Plano invalido.' });
    }

    const companyId = await this.resolveCompanyIdForUser(userId, input.companyId, user.companyId || null);
    const current = await this.ensureEntitledSubscriptionForUser(userId, companyId);
    if (this.isSubscriptionActive(current)) {
      throw new ConflictException({
        code: 'ACTIVE_SUBSCRIPTION_EXISTS',
        message: 'Usuario ja possui uma assinatura ativa.',
      });
    }

    const provider = this.paymentProviderResolver.activeProviderKey;
    const adapter = this.paymentProviderResolver.resolve(provider);
    if (provider === 'MANUAL' || provider === 'ASAAS' || provider === 'MERCADO_PAGO') {
      throw new BadRequestException({
        code: 'PAYMENT_PROVIDER_UNAVAILABLE',
        message: 'Gateway de pagamento temporariamente indisponivel.',
      });
    }

    const plan = await this.prisma.billingPlan.findUnique({
      where: { key: planKey },
      include: { prices: { where: { billingCycle: input.billingCycle, isActive: true } } },
    });
    const price = plan?.prices[0];
    if (!plan || !price) {
      throw new NotFoundException({ code: 'PLAN_NOT_FOUND', message: 'Plano nao encontrado.' });
    }

    const priceUnavailable =
      provider === 'CAKTO'
        ? !price.providerCheckoutUrl
        : provider === 'ABACATEPAY'
          ? !price.abacatepayProductId
          : true;
    if (priceUnavailable) {
      throw new BadRequestException({
        code: 'PLAN_PRICE_UNAVAILABLE',
        message: 'Este plano esta indisponivel no momento.',
      });
    }

    const dbUser = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });
    const externalId = `nextlevel_${userId}_${planKey}_${input.billingCycle}_${Date.now()}`;
    const subscription = await this.prisma.subscription.create({
      data: {
        userId,
        companyId,
        billingPlanId: plan.id,
        planKey,
        billingCycle: input.billingCycle,
        status: SubscriptionStatus.PENDING,
        provider,
        providerProductId: price.providerProductId,
        providerOfferId: price.providerOfferId,
        providerCheckoutUrl: price.providerCheckoutUrl,
        providerRefId: externalId,
        providerSck: externalId,
        providerMetadata: {
          priceId: price.id,
          providerMetadata: price.providerMetadata || null,
        } as Prisma.InputJsonValue,
        source: provider,
        abacatepayExternalId: externalId,
        amountInCents: price.amountInCents,
        currency: price.currency,
        metadata: {
          planKey,
          billingCycle: input.billingCycle,
          source: 'checkout',
          companyId,
        } as Prisma.InputJsonValue,
      },
    });

    const checkout = await adapter.createCheckout({
      userId,
      companyId,
      userEmail: dbUser?.email || null,
      subscriptionId: subscription.id,
      externalId,
      planKey,
      billingCycle: input.billingCycle,
      amountInCents: price.amountInCents,
      currency: price.currency,
      providerProductId: price.providerProductId,
      providerOfferId: price.providerOfferId,
      providerCheckoutUrl: price.providerCheckoutUrl,
      providerMetadata: this.asPlainObject(price.providerMetadata),
      legacyProductId: price.abacatepayProductId,
    });

    await this.prisma.subscription.update({
      where: { id: subscription.id },
      data: {
        providerCheckoutId: checkout.providerCheckoutId || null,
        providerSubscriptionId: checkout.providerSubscriptionId || null,
        providerCustomerId: checkout.providerCustomerId || null,
        providerOrderId: checkout.providerOrderId || null,
        providerOfferId: checkout.providerOfferId || price.providerOfferId,
        providerProductId: checkout.providerProductId || price.providerProductId,
        providerCheckoutUrl: checkout.providerCheckoutUrl || price.providerCheckoutUrl,
        providerRefId: checkout.providerRefId || externalId,
        providerSck: checkout.providerSck || subscription.id,
        providerMetadata: {
          ...(checkout.providerMetadata || {}),
          priceId: price.id,
        } as Prisma.InputJsonValue,
        abacatepayCheckoutId: provider === 'ABACATEPAY' ? checkout.providerCheckoutId || null : null,
        checkoutUrl: checkout.checkoutUrl || null,
        metadata: {
          planKey,
          billingCycle: input.billingCycle,
          provider,
          checkoutStrategy: provider === 'CAKTO' ? 'fixed_checkout_link' : 'api_checkout',
          companyId,
        } as Prisma.InputJsonValue,
      },
    });

    this.logger.log(
      JSON.stringify({
        event: 'billing.checkout.created',
        provider,
        userId,
        companyId,
        subscriptionId: subscription.id,
        planKey,
      }),
    );

    return {
      checkoutUrl: checkout.checkoutUrl,
      subscriptionId: subscription.id,
      provider,
      status: SubscriptionStatus.PENDING,
    };
  }

  async cancelCurrentSubscription(user: AuthUser) {
    const userId = this.resolveUserId(user);
    const subscription = await this.prisma.subscription.findFirst({
      where: { userId, status: { in: ACTIVE_SUBSCRIPTION_STATUSES } },
      orderBy: { createdAt: 'desc' },
    });
    if (!subscription) {
      throw new NotFoundException({ code: 'NO_ACTIVE_SUBSCRIPTION', message: 'Assinatura ativa nao encontrada.' });
    }

    const provider = this.subscriptionProvider(subscription);
    const adapter = this.paymentProviderResolver.resolve(provider);
    const cancelResult = await adapter.cancelSubscription({
      subscriptionId: subscription.id,
      providerSubscriptionId:
        subscription.providerSubscriptionId || subscription.abacatepaySubscriptionId,
    });

    const updated = await this.prisma.subscription.update({
      where: { id: subscription.id },
      data: {
        status: SubscriptionStatus.CANCELLED,
        canceledAt: new Date(),
        providerMetadata: cancelResult.providerMetadata as Prisma.InputJsonValue,
      },
    });
    await this.syncLegacyPlan(updated.userId, updated.companyId, 'COMMON');
    return { success: true, subscription: updated };
  }

  async changePlan(user: AuthUser, input: { planKey: string; billingCycle: BillingCycle; companyId?: string | null }) {
    return this.createCheckout(user, input);
  }

  async handleWebhook(request: Request, providerName?: string) {
    const adapter = this.paymentProviderResolver.resolve(providerName);
    const verified = await adapter.verifyWebhook({
      headers: request.headers as Record<string, unknown>,
      query: request.query as Record<string, unknown>,
      body: request.body,
      rawBody: (request as Request & { rawBody?: Buffer }).rawBody,
    });

    if (!verified.valid) {
      throw new UnauthorizedException({ code: 'INVALID_WEBHOOK_SECRET', message: 'Webhook invalido.' });
    }

    const payload = request.body as Record<string, unknown>;
    const mapped = await adapter.mapWebhookEvent(payload);
    this.logger.log(
      JSON.stringify({
        event: 'billing.webhook.received',
        provider: mapped.provider,
        eventType: mapped.eventType,
        rawEventType: mapped.rawEventType,
      }),
    );
    const providerObjectKey =
      mapped.orderId || mapped.objectId || mapped.checkoutId || mapped.refId || mapped.sck || null;
    const eventId = mapped.eventId
      ? `${mapped.provider}:${mapped.eventId}`
      : providerObjectKey
        ? `${mapped.provider}:${mapped.rawEventType}:${providerObjectKey}`
        : null;

    if (eventId) {
      const existing = await this.prisma.paymentEvent.findUnique({ where: { eventId } });
      if (existing) {
        return { received: true, duplicated: true, processed: existing.processed };
      }
    }

    const event = await this.prisma.paymentEvent.create({
      data: {
        eventId,
        eventType: mapped.eventType,
        provider: mapped.provider,
        providerEventId: mapped.eventId || null,
        providerObjectId: mapped.objectId || null,
        providerOrderId: mapped.orderId || null,
        providerSubscriptionId: mapped.subscriptionId || null,
        providerRawEventType: mapped.rawEventType,
        apiVersion: this.toInt(payload.apiVersion || payload.api_version),
        devMode: Boolean(payload.devMode || payload.dev_mode),
        rawPayload: payload as Prisma.InputJsonValue,
        abacatepayCheckoutId: mapped.provider === 'ABACATEPAY' ? mapped.checkoutId || null : null,
        abacatepaySubscriptionId: mapped.provider === 'ABACATEPAY' ? mapped.subscriptionId || null : null,
      },
    });

    try {
      const subscription = await this.findSubscriptionFromProviderWebhook(mapped);
      const requiresSafeMatch = Boolean(mapped.targetStatus || mapped.shouldActivate);
      if (!subscription && requiresSafeMatch) {
        const message = 'Could not safely match Cakto webhook to local subscription';
        await this.prisma.paymentEvent.update({
          where: { id: event.id },
          data: {
            processingError: message,
            processedAt: new Date(),
          },
        });
        return { received: true, processed: false, reason: message };
      }

      if (subscription && mapped.shouldActivate) {
        const verification = await this.verifyProviderOrderIfNeeded(mapped, subscription);
        if (!verification.valid) {
          await this.prisma.paymentEvent.update({
            where: { id: event.id },
            data: {
              subscriptionId: subscription.id,
              processingError: verification.reason,
              processedAt: new Date(),
            },
          });
          return { received: true, processed: false, reason: verification.reason };
        }
      }

      await this.applyProviderWebhookEvent(mapped, subscription?.id || null);
      await this.prisma.paymentEvent.update({
        where: { id: event.id },
        data: {
          processed: true,
          processedAt: new Date(),
          subscriptionId: subscription?.id || null,
          processingError: mapped.targetStatus ? null : `Evento ignorado: ${mapped.eventType}`,
        },
      });
      return { received: true };
    } catch (error) {
      await this.prisma.paymentEvent.update({
        where: { id: event.id },
        data: {
          processingError: this.extractMessage(error),
          processedAt: new Date(),
        },
      });
      this.logger.error(`Falha ao processar webhook ${mapped.provider}: ${this.extractMessage(error)}`);
      return { received: true, processed: false };
    }
  }

  async findActiveSubscriptionForGuard(userId: string, companyId?: string | null) {
    const subscription = await this.ensureEntitledSubscriptionForUser(userId, companyId);
    return this.isSubscriptionActive(subscription) ? subscription : null;
  }

  private async ensureEntitledSubscriptionForUser(userId: string, companyId?: string | null) {
    const activeByCompany = companyId ? await this.findActiveSubscriptionForCompany(companyId) : null;
    if (activeByCompany) return activeByCompany;

    const active = await this.findActiveSubscription(userId);
    if (active) return active;

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, plan: true, companyId: true, admin: true },
    });
    if (!user) return this.findLatestSubscription(userId);

    const shouldGrantAdmin =
      (user.admin || this.isBillingAdminEmail(user.email)) &&
      (!companyId || companyId === user.companyId);
    if (shouldGrantAdmin) {
      return this.grantInternalSubscription(
        user,
        'PRO_BUSINESS',
        'ADMIN_GRANT',
        'Admin/dev account granted Pro Business access',
        companyId || user.companyId,
      );
    }

    const latestCompanySubscription = companyId
      ? await this.findLatestSubscriptionForCompany(companyId)
      : null;
    if (latestCompanySubscription) {
      return latestCompanySubscription;
    }

    if (this.legacyGraceEnabled) {
      if (user.plan === Plan.ENTERPRISE) {
        return this.grantInternalSubscription(
          user,
          'PRO_BUSINESS',
          'INTERNAL_LEGACY',
          'Legacy ENTERPRISE user migrated to Pro Business entitlement',
          companyId || user.companyId,
        );
      }
      if (user.plan === Plan.PRO) {
        return this.grantInternalSubscription(
          user,
          'PREMIUM',
          'INTERNAL_LEGACY',
          'Legacy PRO user migrated to Premium entitlement',
          companyId || user.companyId,
        );
      }
    }

    return this.findLatestSubscription(userId);
  }

  private async grantInternalSubscription(
    user: { id: string; email: string; plan: Plan; companyId: string | null; admin?: boolean },
    planKey: BillingPlanKey,
    source: InternalGrantSource,
    notes: string,
    companyIdOverride?: string | null,
  ) {
    const existing = await this.prisma.subscription.findFirst({
      where: { userId: user.id, source, status: { in: ACTIVE_SUBSCRIPTION_STATUSES } },
      orderBy: { createdAt: 'desc' },
    });
    if (existing) return existing;

    const billingPlan = await this.ensureBillingPlan(planKey);
    const reusableGrant = await this.prisma.subscription.findFirst({
      where: { userId: user.id, source },
      orderBy: { createdAt: 'desc' },
    });

    const data = {
      companyId: companyIdOverride || user.companyId,
      billingPlanId: billingPlan.id,
      planKey,
      billingCycle: BillingCycle.MONTHLY,
      status: SubscriptionStatus.ACTIVE,
      provider: 'MANUAL',
      source,
      notes,
      amountInCents: 0,
      currency: 'BRL',
      paidAt: new Date(),
      currentPeriodStart: new Date(),
      currentPeriodEnd: null,
      expiresAt: null,
      metadata: {
        source,
        legacyUserPlan: user.plan,
        grantedBy: 'billing_entitlement',
      } as Prisma.InputJsonValue,
    };

    const subscription = reusableGrant
      ? await this.prisma.subscription.update({ where: { id: reusableGrant.id }, data })
      : await this.prisma.subscription.create({ data: { ...data, userId: user.id } });

    await this.syncLegacyPlan(user.id, user.companyId, planKey);
    this.logger.log(
      JSON.stringify({
        event: 'billing.internal_grant.created',
        userId: user.id,
        source,
        planKey,
      }),
    );
    return subscription;
  }

  private async ensureBillingPlan(planKey: BillingPlanKey) {
    const labels: Record<BillingPlanKey, { name: string; description: string }> = {
      COMMON: {
        name: 'Essencial',
        description: 'Plano inicial para organizar dados, acompanhar indicadores e usar IA basica sem integracoes automaticas.',
      },
      PREMIUM: {
        name: 'Premium',
        description: 'Plano para empresas que querem usar IA de verdade na gestao.',
      },
      PRO_BUSINESS: {
        name: 'Business',
        description: 'Plano completo para automacao, previsibilidade, market intelligence e escala.',
      },
    };
    return this.prisma.billingPlan.upsert({
      where: { key: planKey },
      create: {
        key: planKey,
        name: labels[planKey].name,
        description: labels[planKey].description,
        level: PLAN_LEVELS[planKey],
        features: [] as Prisma.InputJsonValue,
      },
      update: {
        level: PLAN_LEVELS[planKey],
        isActive: true,
      },
    });
  }

  private async applyProviderWebhookEvent(
    mapped: BillingWebhookEvent,
    localSubscriptionId: string | null,
  ) {
    if (!localSubscriptionId) return;

    let status = mapped.targetStatus || null;
    if (
      mapped.eventType === 'subscription_created' &&
      ['paid', 'authorized', 'active'].includes(String(mapped.status || '').toLowerCase())
    ) {
      status = SubscriptionStatus.ACTIVE;
    }
    if (!status) return;

    const now = new Date();
    const existing = await this.prisma.subscription.findUnique({
      where: { id: localSubscriptionId },
      select: {
        companyId: true,
        user: { select: { companyId: true } },
      },
    });
    const updated = await this.prisma.subscription.update({
      where: { id: localSubscriptionId },
      data: {
        status,
        companyId: existing?.companyId || existing?.user.companyId || undefined,
        provider: mapped.provider,
        providerCheckoutId: mapped.checkoutId || undefined,
        providerSubscriptionId: mapped.subscriptionId || undefined,
        providerCustomerId: mapped.customerId || undefined,
        providerOrderId: mapped.orderId || undefined,
        providerOfferId: mapped.offerId || undefined,
        providerProductId: mapped.productId || undefined,
        providerRefId: mapped.refId || undefined,
        providerSck: mapped.sck || undefined,
        providerMetadata: {
          customer: mapped.customer || null,
          paymentMethod: mapped.paymentMethod || null,
          amount: mapped.amount || null,
          providerStatus: mapped.status || null,
          rawEventType: mapped.rawEventType,
        } as Prisma.InputJsonValue,
        abacatepayCheckoutId: mapped.provider === 'ABACATEPAY' ? mapped.checkoutId || undefined : undefined,
        abacatepaySubscriptionId: mapped.provider === 'ABACATEPAY' ? mapped.subscriptionId || undefined : undefined,
        abacatepayCustomerId: mapped.provider === 'ABACATEPAY' ? mapped.customerId || undefined : undefined,
        currentPeriodStart: mapped.currentPeriodStart || undefined,
        currentPeriodEnd: mapped.currentPeriodEnd || undefined,
        paidAt:
          status === SubscriptionStatus.ACTIVE || status === SubscriptionStatus.PAID
            ? mapped.paidAt || now
            : undefined,
        canceledAt: status === SubscriptionStatus.CANCELLED ? mapped.canceledAt || now : undefined,
      },
    });

    if (ACTIVE_SUBSCRIPTION_STATUSES.includes(status)) {
      await this.syncLegacyPlan(updated.userId, updated.companyId, updated.planKey);
      this.logger.log(
        JSON.stringify({
          event: 'billing.subscription.activated',
          provider: mapped.provider,
          subscriptionId: updated.id,
          userId: updated.userId,
          companyId: updated.companyId,
          planKey: updated.planKey,
          status: updated.status,
        }),
      );
    } else {
      const blockingStatuses: SubscriptionStatus[] = [
        SubscriptionStatus.CANCELLED,
        SubscriptionStatus.EXPIRED,
        SubscriptionStatus.REFUNDED,
        SubscriptionStatus.FAILED,
        SubscriptionStatus.DISPUTED,
        SubscriptionStatus.LOST,
      ];
      if (blockingStatuses.includes(status)) {
        await this.syncLegacyPlan(updated.userId, updated.companyId, 'COMMON');
      }
    }
  }

  private async findSubscriptionFromProviderWebhook(mapped: BillingWebhookEvent) {
    const provider = mapped.provider;

    if (mapped.sck || mapped.refId) {
      const byTracking = await this.prisma.subscription.findFirst({
        where: {
          OR: [
            mapped.sck ? { id: mapped.sck } : undefined,
            mapped.sck ? { providerSck: mapped.sck } : undefined,
            mapped.refId ? { providerRefId: mapped.refId } : undefined,
            mapped.refId ? { abacatepayExternalId: mapped.refId } : undefined,
          ].filter(Boolean) as Prisma.SubscriptionWhereInput[],
        },
        orderBy: { createdAt: 'desc' },
      });
      if (byTracking) return byTracking;
    }

    if (mapped.orderId) {
      const byOrder = await this.prisma.subscription.findFirst({
        where: { provider, providerOrderId: mapped.orderId },
        orderBy: { createdAt: 'desc' },
      });
      if (byOrder) return byOrder;
    }

    if (mapped.subscriptionId) {
      const bySubscription = await this.prisma.subscription.findFirst({
        where: {
          OR: [
            { provider, providerSubscriptionId: mapped.subscriptionId },
            provider === 'ABACATEPAY' ? { abacatepaySubscriptionId: mapped.subscriptionId } : undefined,
          ].filter(Boolean) as Prisma.SubscriptionWhereInput[],
        },
        orderBy: { createdAt: 'desc' },
      });
      if (bySubscription) return bySubscription;
    }

    if (mapped.checkoutId && provider === 'ABACATEPAY') {
      const byCheckout = await this.prisma.subscription.findFirst({
        where: { abacatepayCheckoutId: mapped.checkoutId },
        orderBy: { createdAt: 'desc' },
      });
      if (byCheckout) return byCheckout;
    }

    const email = mapped.customerEmail?.trim().toLowerCase();
    if (!email) return null;

    const user = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true },
    });
    if (!user) return null;

    const offerOrProductFilters = [
      mapped.offerId ? { providerOfferId: mapped.offerId } : undefined,
      mapped.productId ? { providerProductId: mapped.productId } : undefined,
    ].filter(Boolean) as Prisma.SubscriptionWhereInput[];

    if (offerOrProductFilters.length > 0) {
      const matches = await this.prisma.subscription.findMany({
        where: {
          userId: user.id,
          provider,
          status: { in: [SubscriptionStatus.PENDING, SubscriptionStatus.ACTIVE, SubscriptionStatus.PAID] },
          OR: offerOrProductFilters,
        },
        orderBy: { createdAt: 'desc' },
        take: 2,
      });
      if (matches.length === 1) return matches[0];
    }

    const pendingMatches = await this.prisma.subscription.findMany({
      where: {
        userId: user.id,
        provider,
        status: SubscriptionStatus.PENDING,
      },
      orderBy: { createdAt: 'desc' },
      take: 2,
    });
    return pendingMatches.length === 1 ? pendingMatches[0] : null;
  }

  private async verifyProviderOrderIfNeeded(
    mapped: BillingWebhookEvent,
    subscription: {
      userId: string;
      providerOfferId?: string | null;
      providerProductId?: string | null;
    },
  ) {
    if (mapped.provider !== 'CAKTO' || !mapped.orderId || !this.isTrue(this.configService.get<string>('CAKTO_VERIFY_ORDER_ON_WEBHOOK'))) {
      return { valid: true };
    }

    try {
      const order = await this.caktoProvider.getOrder(mapped.orderId);
      const orderStatus = String(order.status || '').toLowerCase();
      if (!['paid', 'authorized'].includes(orderStatus)) {
        return { valid: false, reason: `Cakto order status not paid/authorized: ${orderStatus}` };
      }

      const user = await this.prisma.user.findUnique({
        where: { id: subscription.userId },
        select: { email: true },
      });
      const orderEmail = order.customer?.email?.trim().toLowerCase();
      if (user?.email && orderEmail && user.email.trim().toLowerCase() !== orderEmail) {
        return { valid: false, reason: 'Cakto order customer email does not match local user' };
      }

      const orderProductId =
        order.product && typeof order.product === 'object' ? order.product.id : order.product;
      if (
        subscription.providerProductId &&
        orderProductId &&
        subscription.providerProductId !== orderProductId
      ) {
        return { valid: false, reason: 'Cakto order product does not match local price' };
      }

      return { valid: true };
    } catch (error) {
      return { valid: false, reason: `Cakto order verification failed: ${this.extractMessage(error)}` };
    }
  }

  private async applyWebhookEvent(
    eventType: string,
    localSubscriptionId: string | null,
    data: Record<string, unknown>,
    ids: { checkoutId: string | null; subscriptionId: string | null },
  ) {
    if (!localSubscriptionId) return;

    const now = new Date();
    const updateBase = {
      abacatepayCheckoutId: ids.checkoutId || undefined,
      abacatepaySubscriptionId: ids.subscriptionId || undefined,
      abacatepayCustomerId: this.extractString(data, ['customerId', 'customer_id']) || undefined,
      currentPeriodStart: this.extractDate(data, ['currentPeriodStart', 'current_period_start', 'periodStart']),
      currentPeriodEnd: this.extractDate(data, ['currentPeriodEnd', 'current_period_end', 'periodEnd']),
    };

    let status: SubscriptionStatus | null = null;
    let paidAt: Date | undefined;
    let canceledAt: Date | undefined;

    if (['checkout.completed', 'subscription.completed', 'subscription.renewed'].includes(eventType)) {
      status = eventType === 'checkout.completed' ? SubscriptionStatus.PAID : SubscriptionStatus.ACTIVE;
      paidAt = now;
    } else if (eventType === 'subscription.cancelled') {
      status = SubscriptionStatus.CANCELLED;
      canceledAt = now;
    } else if (eventType === 'checkout.refunded') {
      status = SubscriptionStatus.REFUNDED;
    } else if (eventType === 'checkout.disputed') {
      status = SubscriptionStatus.DISPUTED;
    } else if (eventType === 'checkout.lost') {
      status = SubscriptionStatus.LOST;
    } else if (eventType === 'subscription.payment_failed') {
      status = SubscriptionStatus.FAILED;
    } else if (eventType === 'subscription.trial_started') {
      status = SubscriptionStatus.TRIAL;
    }

    if (!status) return;

    const updated = await this.prisma.subscription.update({
      where: { id: localSubscriptionId },
      data: {
        ...updateBase,
        status,
        paidAt,
        canceledAt,
      },
    });

    if (ACTIVE_SUBSCRIPTION_STATUSES.includes(status)) {
      await this.syncLegacyPlan(updated.userId, updated.companyId, updated.planKey);
    } else {
      await this.syncLegacyPlan(updated.userId, updated.companyId, 'COMMON');
    }
  }

  private async syncLegacyPlan(userId: string, companyId: string | null, planKey: string) {
    const normalized = normalizeBillingPlanKey(planKey) || 'COMMON';
    const legacyPlan = LEGACY_PLAN_BY_BILLING_KEY[normalized];
    await this.prisma.user.update({
      where: { id: userId },
      data: { plan: legacyPlan },
    });

    if (companyId) {
      await this.prisma.usageQuota.upsert({
        where: { companyId },
        create: {
          companyId,
          currentTier: legacyPlan,
          billingCycleEnd: this.addDays(new Date(), 30),
          llmTokensUsed: 0,
          whatsappMessagesSent: 0,
        },
        update: {
          currentTier: legacyPlan,
        },
      });
    }
  }

  private async findSubscriptionFromWebhook(data: Record<string, unknown>) {
    const metadata = (data.metadata || {}) as Record<string, unknown>;
    const localSubscriptionId = this.extractString(metadata, ['localSubscriptionId', 'subscriptionId']);
    if (localSubscriptionId) {
      const byLocalId = await this.prisma.subscription.findUnique({ where: { id: localSubscriptionId } });
      if (byLocalId) return byLocalId;
    }

    const externalId =
      this.extractString(data, ['externalId', 'external_id']) ||
      this.extractString(metadata, ['externalId', 'external_id']);
    if (externalId) {
      const byExternal = await this.prisma.subscription.findUnique({
        where: { abacatepayExternalId: externalId },
      });
      if (byExternal) return byExternal;
    }

    const ids = this.extractPaymentIds({}, data);
    return this.prisma.subscription.findFirst({
      where: {
        OR: [
          ids.checkoutId ? { abacatepayCheckoutId: ids.checkoutId } : undefined,
          ids.subscriptionId ? { abacatepaySubscriptionId: ids.subscriptionId } : undefined,
        ].filter(Boolean) as Prisma.SubscriptionWhereInput[],
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  private async findActiveSubscription(userId: string) {
    const subscriptions = await this.prisma.subscription.findMany({
      where: { userId, status: { in: ACTIVE_SUBSCRIPTION_STATUSES } },
      orderBy: { createdAt: 'desc' },
      take: 5,
    });
    return subscriptions.find((subscription) => this.isSubscriptionActive(subscription)) || null;
  }

  private async findActiveSubscriptionForCompany(companyId: string) {
    const subscriptions = await this.prisma.subscription.findMany({
      where: { companyId, status: { in: ACTIVE_SUBSCRIPTION_STATUSES } },
      orderBy: { createdAt: 'desc' },
      take: 5,
    });
    return subscriptions.find((subscription) => this.isSubscriptionActive(subscription)) || null;
  }

  private async findLatestSubscription(userId: string) {
    return this.prisma.subscription.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
  }

  private async findLatestSubscriptionForCompany(companyId: string) {
    return this.prisma.subscription.findFirst({
      where: { companyId },
      orderBy: { createdAt: 'desc' },
    });
  }

  private isSubscriptionActive(subscription: { status: SubscriptionStatus; currentPeriodEnd?: Date | null; expiresAt?: Date | null } | null) {
    if (!subscription) return false;
    if (!ACTIVE_SUBSCRIPTION_STATUSES.includes(subscription.status)) return false;
    const now = Date.now();
    if (subscription.currentPeriodEnd && subscription.currentPeriodEnd.getTime() <= now) return false;
    if (subscription.expiresAt && subscription.expiresAt.getTime() <= now) return false;
    return true;
  }

  private subscriptionProvider(subscription: { provider?: string | null; source?: string | null }) {
    const provider =
      subscription.provider && subscription.provider !== 'MANUAL'
        ? subscription.provider
        : subscription.source;
    return this.paymentProviderResolver.normalizeProvider(provider);
  }

  private asPlainObject(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  }

  private validateWebhookSecret(request: Request) {
    const expected = this.configService.get<string>('ABACATEPAY_WEBHOOK_SECRET');
    if (!expected?.trim()) return false;

    const supplied =
      this.headerValue(request, 'x-abacatepay-secret') ||
      this.headerValue(request, 'x-webhook-secret') ||
      this.queryValue(request, 'webhookSecret') ||
      this.queryValue(request, 'secret');

    const hasSharedSecret = supplied ? this.safeCompare(supplied, expected) : false;
    const signature = this.headerValue(request, 'x-webhook-signature');
    if (!signature) return hasSharedSecret;

    const rawBody = (request as Request & { rawBody?: Buffer }).rawBody;
    if (!rawBody) return hasSharedSecret;
    const hmacKey =
      this.configService.get<string>('ABACATEPAY_WEBHOOK_PUBLIC_KEY') ||
      expected;
    const digestBase64 = createHmac('sha256', hmacKey).update(rawBody).digest('base64');
    const digestHex = createHmac('sha256', hmacKey).update(rawBody).digest('hex');
    return (
      this.safeCompare(signature, digestBase64) ||
      this.safeCompare(signature, digestHex) ||
      hasSharedSecret
    );
  }

  private safeCompare(a: string, b: string) {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    if (left.length !== right.length) return false;
    return timingSafeEqual(left, right);
  }

  private subscriptionMethods() {
    if (!this.isTrue(this.configService.get<string>('ABACATEPAY_ENABLE_PIX_SUBSCRIPTIONS'))) {
      return ['CARD'];
    }

    const raw = this.configService.get<string>('ABACATEPAY_SUBSCRIPTION_METHODS') || 'CARD';
    const parsed = this.parsePaymentMethods(raw);
    return parsed.length ? parsed : ['CARD'];
  }

  private parsePaymentMethods(raw: string) {
    const allowed = new Set(['PIX', 'CARD']);
    let values: unknown[] = [];
    const trimmed = raw.trim();

    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        values = Array.isArray(parsed) ? parsed : [parsed];
      } catch {
        values = [trimmed];
      }
    } else {
      values = trimmed.split(',');
    }

    return Array.from(
      new Set(
        values
          .flatMap((value) => String(value || '').split(','))
          .map((value) => value.trim().toUpperCase())
          .filter((value) => allowed.has(value)),
      ),
    );
  }

  private isBillingAdminEmail(email: string) {
    const configured = this.configService.get<string>('BILLING_ADMIN_EMAILS') || '';
    const allowed = configured
      .split(',')
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean);
    return allowed.includes(email.trim().toLowerCase());
  }

  private get legacyGraceEnabled() {
    return this.isTrue(this.configService.get<string>('BILLING_LEGACY_GRACE_ENABLED'));
  }

  private isTrue(value: unknown) {
    return String(value || '').trim().toLowerCase() === 'true';
  }

  private get frontendUrl() {
    return (
      this.configService.get<string>('FRONTEND_URL') ||
      this.configService.get<string>('FRONTEND_APP_URL') ||
      'http://localhost:5173'
    ).replace(/\/+$/, '');
  }

  private resolveUserId(user: AuthUser) {
    const userId = user.id || user.userId || user.sub;
    if (!userId) {
      throw new BadRequestException('Usuario autenticado invalido.');
    }
    return userId;
  }

  private async resolveCompanyIdForUser(
    userId: string,
    requestedCompanyId?: string | null,
    fallbackCompanyId?: string | null,
  ) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { companyId: true, admin: true },
    });
    const candidate = requestedCompanyId?.trim() || fallbackCompanyId?.trim() || user?.companyId || null;
    if (!candidate) return null;

    const company = await this.prisma.company.findFirst({
      where: {
        id: candidate,
        ...(user?.admin
          ? {}
          : {
              OR: [{ userId }, { users: { some: { id: userId } } }],
            }),
      },
      select: { id: true },
    });
    if (!company) {
      throw new ForbiddenException('Sem acesso a empresa informada');
    }
    return company.id;
  }

  private extractEventType(payload: Record<string, unknown>) {
    const raw = this.extractString(payload, ['event', 'type', 'eventType', 'event_type']) || 'unknown';
    return this.normalizeAbacatePayEvent(raw);
  }

  private normalizeAbacatePayEvent(eventType: string) {
    const eventMap: Record<string, string> = {
      'assinatura.concluida': 'subscription.completed',
      'assinatura.renovada': 'subscription.renewed',
      'assinatura.cancelada': 'subscription.cancelled',
      'assinatura.pagamento_falha': 'subscription.payment_failed',
      'checkout.concluido': 'checkout.completed',
      'checkout.reembolsado': 'checkout.refunded',
      'checkout.disputado': 'checkout.disputed',
      'checkout.perdido': 'checkout.lost',
    };
    return eventMap[eventType] || eventType;
  }

  private extractData(payload: Record<string, unknown>) {
    const data = payload.data || payload.object || payload.payload;
    return data && typeof data === 'object' ? (data as Record<string, unknown>) : payload;
  }

  private extractPaymentIds(payload: Record<string, unknown>, data: Record<string, unknown>) {
    return {
      checkoutId: this.extractString(data, ['id', 'checkoutId', 'checkout_id', 'billingId']) ||
        this.extractString(payload, ['checkoutId', 'checkout_id']),
      subscriptionId:
        this.extractString(data, ['subscriptionId', 'subscription_id']) ||
        this.extractString(payload, ['subscriptionId', 'subscription_id']),
    };
  }

  private extractString(source: Record<string, unknown>, keys: string[]) {
    for (const key of keys) {
      const value = source[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return null;
  }

  private extractDate(source: Record<string, unknown>, keys: string[]) {
    const raw = this.extractString(source, keys);
    if (!raw) return undefined;
    const date = new Date(raw);
    return Number.isNaN(date.getTime()) ? undefined : date;
  }

  private headerValue(request: Request, key: string) {
    const value = request.headers[key] || request.headers[key.toLowerCase()];
    return Array.isArray(value) ? value[0] : value || null;
  }

  private queryValue(request: Request, key: string) {
    const value = request.query[key];
    return Array.isArray(value) ? String(value[0]) : value ? String(value) : null;
  }

  private toInt(value: unknown) {
    const parsed = Number(value);
    return Number.isInteger(parsed) ? parsed : null;
  }

  private addDays(date: Date, days: number) {
    const clone = new Date(date);
    clone.setUTCDate(clone.getUTCDate() + days);
    return clone;
  }

  private extractMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
}
