import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BillingCycle, Plan, Prisma, SubscriptionStatus } from '@prisma/client';
import { Request } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { AbacatePayService } from './abacatepay.service';
import {
  ACTIVE_SUBSCRIPTION_STATUSES,
  BillingPlanKey,
  LEGACY_PLAN_BY_BILLING_KEY,
  PLAN_LEVELS,
  normalizeBillingPlanKey,
} from './constants/billing.constants';

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
    private readonly abacatePayService: AbacatePayService,
  ) {}

  async getBillingForUser(userId: string) {
    const subscription = await this.ensureEntitledSubscriptionForUser(userId);
    const hasActiveSubscription = this.isSubscriptionActive(subscription);
    return {
      hasActiveSubscription,
      subscription: subscription
        ? {
            id: subscription.id,
            planKey: subscription.planKey,
            billingCycle: subscription.billingCycle,
            status: subscription.status,
            source: subscription.source,
            currentPeriodEnd: subscription.currentPeriodEnd,
            expiresAt: subscription.expiresAt,
          }
        : null,
    };
  }

  async createCheckout(user: AuthUser, input: { planKey: string; billingCycle: BillingCycle }) {
    const userId = this.resolveUserId(user);
    const planKey = normalizeBillingPlanKey(input.planKey);
    if (!planKey) {
      throw new BadRequestException({ code: 'INVALID_PLAN', message: 'Plano invalido.' });
    }

    const current = await this.ensureEntitledSubscriptionForUser(userId);
    if (this.isSubscriptionActive(current)) {
      throw new ConflictException({
        code: 'ACTIVE_SUBSCRIPTION_EXISTS',
        message: 'Usuario ja possui uma assinatura ativa.',
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
    if (!price.abacatepayProductId) {
      throw new BadRequestException({
        code: 'PLAN_PRICE_UNAVAILABLE',
        message: 'Este plano esta indisponivel no momento.',
      });
    }

    const externalId = `nextlevel_${userId}_${planKey}_${input.billingCycle}_${Date.now()}`;
    const subscription = await this.prisma.subscription.create({
      data: {
        userId,
        companyId: user.companyId || null,
        billingPlanId: plan.id,
        planKey,
        billingCycle: input.billingCycle,
        status: SubscriptionStatus.PENDING,
        source: 'ABACATEPAY',
        abacatepayExternalId: externalId,
        amountInCents: price.amountInCents,
        currency: price.currency,
        metadata: {
          planKey,
          billingCycle: input.billingCycle,
          source: 'checkout',
        } as Prisma.InputJsonValue,
      },
    });

    const methods = this.subscriptionMethods();
    this.logger.log(
      JSON.stringify({
        event: 'billing.checkout.create',
        endpoint: '/subscriptions/create',
        productId: price.abacatepayProductId,
        planKey,
        billingCycle: input.billingCycle,
        methods,
        externalId,
      }),
    );

    const checkout = await this.abacatePayService.createSubscriptionCheckout({
      productId: price.abacatepayProductId,
      methods,
      externalId,
      returnUrl: `${this.frontendUrl}/planos`,
      completionUrl: `${this.frontendUrl}/billing/success`,
      metadata: {
        localSubscriptionId: subscription.id,
        userId,
        companyId: user.companyId || null,
        planKey,
        billingCycle: input.billingCycle,
      },
    });

    await this.prisma.subscription.update({
      where: { id: subscription.id },
      data: {
        abacatepayCheckoutId: checkout.id || null,
        checkoutUrl: checkout.url || null,
        metadata: {
          planKey,
          billingCycle: input.billingCycle,
          abacatepayStatus: checkout.status || null,
        } as Prisma.InputJsonValue,
      },
    });

    return {
      checkoutUrl: checkout.url,
      subscriptionId: subscription.id,
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

    if (subscription.abacatepaySubscriptionId) {
      await this.abacatePayService.cancelSubscription(subscription.abacatepaySubscriptionId);
    }

    const updated = await this.prisma.subscription.update({
      where: { id: subscription.id },
      data: { status: SubscriptionStatus.CANCELLED, canceledAt: new Date() },
    });
    await this.syncLegacyPlan(updated.userId, updated.companyId, 'COMMON');
    return { success: true, subscription: updated };
  }

  async changePlan(user: AuthUser, input: { planKey: string; billingCycle: BillingCycle }) {
    return this.createCheckout(user, input);
  }

  async handleWebhook(request: Request) {
    if (!this.validateWebhookSecret(request)) {
      throw new ForbiddenException({ code: 'INVALID_WEBHOOK_SECRET', message: 'Webhook invalido.' });
    }

    const payload = request.body as Record<string, unknown>;
    const eventType = this.extractEventType(payload);
    const data = this.extractData(payload);
    const ids = this.extractPaymentIds(payload, data);
    const eventId = this.extractString(payload, ['id', 'eventId', 'event_id']);

    if (eventId) {
      const existing = await this.prisma.paymentEvent.findUnique({ where: { eventId } });
      if (existing?.processed) {
        return { received: true, duplicated: true };
      }
    }

    const event = await this.prisma.paymentEvent.create({
      data: {
        eventId: eventId || null,
        eventType,
        apiVersion: this.toInt(payload.apiVersion || payload.api_version),
        devMode: Boolean(payload.devMode || payload.dev_mode),
        rawPayload: payload as Prisma.InputJsonValue,
        abacatepayCheckoutId: ids.checkoutId,
        abacatepaySubscriptionId: ids.subscriptionId,
      },
    });

    try {
      const subscription = await this.findSubscriptionFromWebhook(data);
      await this.applyWebhookEvent(eventType, subscription?.id || null, data, ids);
      await this.prisma.paymentEvent.update({
        where: { id: event.id },
        data: {
          processed: true,
          processedAt: new Date(),
          subscriptionId: subscription?.id || null,
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
      this.logger.error(`Falha ao processar webhook AbacatePay: ${this.extractMessage(error)}`);
      throw error;
    }
  }

  async findActiveSubscriptionForGuard(userId: string) {
    const subscription = await this.ensureEntitledSubscriptionForUser(userId);
    return this.isSubscriptionActive(subscription) ? subscription : null;
  }

  private async ensureEntitledSubscriptionForUser(userId: string) {
    const active = await this.findActiveSubscription(userId);
    if (active) return active;

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, plan: true, companyId: true },
    });
    if (!user) return this.findLatestSubscription(userId);

    if (this.isBillingAdminEmail(user.email)) {
      return this.grantInternalSubscription(
        user,
        'PRO_BUSINESS',
        'ADMIN_GRANT',
        'Admin/dev account granted Pro Business access',
      );
    }

    if (this.legacyGraceEnabled) {
      if (user.plan === Plan.ENTERPRISE) {
        return this.grantInternalSubscription(
          user,
          'PRO_BUSINESS',
          'INTERNAL_LEGACY',
          'Legacy ENTERPRISE user migrated to Pro Business entitlement',
        );
      }
      if (user.plan === Plan.PRO) {
        return this.grantInternalSubscription(
          user,
          'PREMIUM',
          'INTERNAL_LEGACY',
          'Legacy PRO user migrated to Premium entitlement',
        );
      }
    }

    return this.findLatestSubscription(userId);
  }

  private async grantInternalSubscription(
    user: { id: string; email: string; plan: Plan; companyId: string | null },
    planKey: BillingPlanKey,
    source: InternalGrantSource,
    notes: string,
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
      companyId: user.companyId,
      billingPlanId: billingPlan.id,
      planKey,
      billingCycle: BillingCycle.MONTHLY,
      status: SubscriptionStatus.ACTIVE,
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
        name: 'Comum',
        description: 'Plano inicial para organizar dados e acompanhar indicadores basicos.',
      },
      PREMIUM: {
        name: 'Premium',
        description: 'Plano para empresas que querem usar IA de verdade na gestao.',
      },
      PRO_BUSINESS: {
        name: 'Pro Business',
        description: 'Plano completo para automacao, market intelligence e recursos avancados.',
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
    return this.prisma.subscription.findFirst({
      where: { userId, status: { in: ACTIVE_SUBSCRIPTION_STATUSES } },
      orderBy: { createdAt: 'desc' },
    });
  }

  private async findLatestSubscription(userId: string) {
    return this.prisma.subscription.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
  }

  private isSubscriptionActive(subscription: { status: SubscriptionStatus; currentPeriodEnd?: Date | null } | null) {
    if (!subscription) return false;
    if (ACTIVE_SUBSCRIPTION_STATUSES.includes(subscription.status)) return true;
    return false;
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
