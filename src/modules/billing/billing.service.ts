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
import { PrismaService } from '../../prisma/prisma.service';
import {
  ACTIVE_SUBSCRIPTION_STATUSES,
  BillingPlanKey,
  LEGACY_PLAN_BY_BILLING_KEY,
  PLAN_LEVELS,
  normalizeBillingCycle,
  normalizeBillingPlanKey,
} from './constants/billing.constants';
import { PlanEntitlementsService } from './plan-entitlements.service';
import {
  StripeCheckoutSessionRecord,
  StripeInvoiceRecord,
  StripeService,
  StripeSubscriptionRecord,
  StripeWebhookEventRecord,
} from './stripe.service';

type AuthUser = {
  id?: string;
  userId?: string;
  sub?: string;
  companyId?: string | null;
  admin?: boolean;
};

type CheckoutInput = {
  planKey: string;
  billingCycle?: BillingCycle | string;
  billingInterval?: string;
  companyId?: string | null;
};

type ChangePlanInput = {
  planKey?: string;
  targetPlanKey?: string;
  billingCycle?: BillingCycle | string;
  billingInterval?: string;
  companyId?: string | null;
};

type InternalGrantSource = 'INTERNAL_LEGACY' | 'MANUAL_GRANT' | 'ADMIN_GRANT';

type StripeSubscriptionLike = StripeSubscriptionRecord;
type StripeInvoiceLike = StripeInvoiceRecord;

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly stripeService: StripeService,
    private readonly planEntitlements: PlanEntitlementsService,
  ) {}

  async getBillingForUser(userId: string, companyId?: string | null) {
    const scopedCompanyId = await this.resolveCompanyIdForUser(userId, companyId, null);
    const subscription = await this.ensureEntitledSubscriptionForUser(userId, scopedCompanyId);
    const hasActiveSubscription = this.isSubscriptionActive(subscription);
    const planKey = normalizeBillingPlanKey(subscription?.planKey) || 'COMMON';
    const entitlements = this.planEntitlements.getEntitlements(planKey);
    const aiUsage = scopedCompanyId
      ? await this.getAiUsageSummary(scopedCompanyId, planKey)
      : null;

    return {
      hasActiveSubscription,
      activePlan: hasActiveSubscription ? planKey : null,
      subscription: subscription
        ? {
            id: subscription.id,
            planKey: subscription.planKey,
            billingCycle: subscription.billingCycle,
            status: subscription.status,
            provider: subscription.provider,
            source: subscription.source,
            currentPeriodStart: subscription.currentPeriodStart,
            currentPeriodEnd: subscription.currentPeriodEnd,
            cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
            expiresAt: subscription.expiresAt,
          }
        : null,
      limits: entitlements.quotas,
      features: {
        integrations: this.planEntitlements.canAccessFeature(planKey, 'WHATSAPP_INTEGRATION'),
        aiChat: this.planEntitlements.canAccessFeature(planKey, 'AI_CHAT'),
        basicDashboard: this.planEntitlements.canAccessFeature(planKey, 'DASHBOARD_BASIC'),
        advancedInsights: this.planEntitlements.canAccessFeature(planKey, 'DASHBOARD_ADVANCED'),
        reports: this.planEntitlements.canAccessFeature(planKey, 'REPORTS_SIMPLE'),
      },
      aiUsage,
    };
  }

  async getBillingConfig() {
    const backendUrl = this.backendUrl;
    const configured = this.stripeService.isConfigured() && this.hasAnyStripePriceConfigured();

    return {
      paymentProvider: 'STRIPE',
      checkoutEnabled: configured,
      message: configured ? null : 'Pagamento seguro ainda precisa das chaves de ambiente.',
      webhookUrl: `${backendUrl}/api/billing/webhook/stripe`,
    };
  }

  async createCheckout(user: AuthUser, input: CheckoutInput) {
    const userId = this.resolveUserId(user);
    const planKey = normalizeBillingPlanKey(input.planKey);
    const billingCycle = normalizeBillingCycle(input.billingCycle || input.billingInterval);
    if (!planKey || !billingCycle) {
      throw new BadRequestException({ code: 'INVALID_PLAN', message: 'Plano invalido.' });
    }

    const companyId = await this.resolveCompanyIdForUser(userId, input.companyId, user.companyId || null);
    if (!companyId) {
      throw new BadRequestException({ code: 'COMPANY_REQUIRED', message: 'Selecione uma empresa para assinar.' });
    }

    const current = await this.ensureEntitledSubscriptionForUser(userId, companyId);
    if (this.isSubscriptionActive(current) && current?.planKey === planKey) {
      throw new ConflictException({
        code: 'ACTIVE_SUBSCRIPTION_EXISTS',
        message: 'Este plano ja esta ativo para sua empresa.',
      });
    }

    const plan = await this.prisma.billingPlan.findUnique({
      where: { key: planKey },
      include: { prices: { where: { billingCycle, isActive: true } } },
    });
    const price = plan?.prices[0];
    const stripePriceId = this.getStripePriceId(planKey, billingCycle);
    if (!plan || !price || !stripePriceId) {
      throw new NotFoundException({ code: 'PLAN_PRICE_UNAVAILABLE', message: 'Este plano esta indisponivel no momento.' });
    }

    const [dbUser, company] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        select: { email: true, name: true },
      }),
      this.prisma.company.findUnique({
        where: { id: companyId },
        select: { id: true, name: true, stripeCustomerId: true },
      }),
    ]);

    if (!company) {
      throw new ForbiddenException('Sem acesso a empresa informada');
    }

    const stripeCustomerId = await this.getOrCreateStripeCustomer({
      companyId,
      currentCustomerId: company.stripeCustomerId,
      companyName: company.name,
      userEmail: dbUser?.email || null,
      userName: dbUser?.name || null,
    });

    const subscription = await this.prisma.subscription.create({
      data: {
        userId,
        companyId,
        billingPlanId: plan.id,
        planKey,
        billingCycle,
        status: SubscriptionStatus.PENDING,
        provider: 'STRIPE',
        source: 'STRIPE',
        providerCustomerId: stripeCustomerId,
        providerProductId: stripePriceId,
        stripeCustomerId,
        stripePriceId,
        amountInCents: price.amountInCents,
        currency: price.currency,
        metadata: {
          planKey,
          billingCycle,
          billingInterval: this.toStripeInterval(billingCycle),
          source: 'next_level_ai',
          companyId,
        } as Prisma.InputJsonValue,
      },
    });

    const metadata = {
      userId,
      companyId,
      planKey: this.toPublicPlanKey(planKey),
      billingInterval: this.toStripeInterval(billingCycle),
      source: 'next_level_ai',
      localSubscriptionId: subscription.id,
    };

    const session = await this.stripeService.createSubscriptionCheckoutSession({
      customer: stripeCustomerId,
      priceId: stripePriceId,
      successUrl: `${this.frontendUrl}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${this.frontendUrl}/billing/cancel`,
      clientReferenceId: subscription.id,
      metadata,
    });

    await this.prisma.subscription.update({
      where: { id: subscription.id },
      data: {
        checkoutUrl: session.url || null,
        providerCheckoutId: session.id,
        stripeCheckoutSessionId: session.id,
        providerMetadata: {
          stripeSessionId: session.id,
          stripePriceId,
        } as Prisma.InputJsonValue,
      },
    });

    this.logger.log(JSON.stringify({
      event: 'billing.stripe.checkout.created',
      userId,
      companyId,
      subscriptionId: subscription.id,
      planKey,
      billingCycle,
    }));

    return { checkoutUrl: session.url };
  }

  async createPortal(user: AuthUser, companyIdInput?: string | null) {
    const userId = this.resolveUserId(user);
    const companyId = await this.resolveCompanyIdForUser(userId, companyIdInput, user.companyId || null);
    if (!companyId) {
      throw new BadRequestException({ code: 'COMPANY_REQUIRED', message: 'Selecione uma empresa para gerenciar a assinatura.' });
    }

    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { stripeCustomerId: true },
    });
    const subscription = await this.prisma.subscription.findFirst({
      where: { companyId },
      orderBy: { createdAt: 'desc' },
      select: { stripeCustomerId: true, providerCustomerId: true },
    });
    const customer = company?.stripeCustomerId || subscription?.stripeCustomerId || subscription?.providerCustomerId;
    if (!customer) {
      throw new NotFoundException({
        code: 'STRIPE_CUSTOMER_NOT_FOUND',
        message: 'Nenhuma assinatura ativa encontrada para esta empresa.',
      });
    }

    const session = await this.stripeService.createPortalSession({
      customer,
      returnUrl: `${this.frontendUrl}/planos`,
    });

    return { portalUrl: session.url };
  }

  async reconcileCheckoutSessionStatus(
    user: AuthUser,
    sessionIdInput: string,
    companyIdInput?: string | null,
  ) {
    const userId = this.resolveUserId(user);
    const sessionId = String(sessionIdInput || '').trim();
    if (!sessionId || !sessionId.startsWith('cs_')) {
      throw new BadRequestException({ code: 'INVALID_CHECKOUT_SESSION', message: 'Sessao de pagamento invalida.' });
    }

    const session = await this.stripeService.retrieveCheckoutSession(sessionId);
    const metadata = session.metadata || {};
    const localSubscriptionId =
      this.stringValue(metadata.localSubscriptionId) || this.stringValue(session.client_reference_id);
    const metadataUserId = this.stringValue(metadata.userId);
    const metadataCompanyId = this.stringValue(metadata.companyId);
    const localSubscription = await this.findStripeLocalSubscription({
      localSubscriptionId,
      stripeSubscriptionId: this.asStripeId(session.subscription),
      checkoutSessionId: session.id,
    });

    const companyId = await this.resolveCompanyIdForUser(
      userId,
      companyIdInput || metadataCompanyId || localSubscription?.companyId || null,
      user.companyId || null,
    );
    if (!companyId) {
      throw new BadRequestException({ code: 'COMPANY_REQUIRED', message: 'Selecione uma empresa para confirmar o plano.' });
    }

    if (metadataUserId && metadataUserId !== userId && localSubscription?.userId !== userId) {
      throw new ForbiddenException('Sessao de pagamento nao pertence ao usuario autenticado.');
    }
    const sessionCompanyId = metadataCompanyId || localSubscription?.companyId;
    if (sessionCompanyId && sessionCompanyId !== companyId) {
      throw new ForbiddenException('Sessao de pagamento nao pertence a empresa ativa.');
    }

    const stripeSubscriptionId = this.asStripeId(session.subscription);
    if (stripeSubscriptionId && this.isCheckoutSessionReadyForReconciliation(session)) {
      const stripeSubscription = this.isStripeSubscriptionRecord(session.subscription)
        ? session.subscription
        : await this.stripeService.retrieveSubscription(stripeSubscriptionId);
      await this.applyStripeSubscription(stripeSubscription, undefined, session);
    }

    const billing = await this.getBillingForUser(userId, companyId);
    const hasActiveSubscription = Boolean(billing.hasActiveSubscription);
    const status = hasActiveSubscription
      ? 'ACTIVE'
      : this.isCheckoutSessionReadyForReconciliation(session)
        ? 'AWAITING_STRIPE_WEBHOOK'
        : 'PENDING_PAYMENT';

    return {
      status,
      hasActiveSubscription,
      checkoutSession: {
        id: session.id,
        stripeStatus: session.status || null,
        paymentStatus: session.payment_status || null,
      },
      billing,
      message: hasActiveSubscription
        ? 'Plano ativado com sucesso.'
        : this.isCheckoutSessionReadyForReconciliation(session)
          ? 'Estamos aguardando a confirmacao final do pagamento.'
          : 'Confirmando pagamento.',
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

    if (subscription.stripeSubscriptionId || subscription.providerSubscriptionId) {
      await this.stripeService.cancelAtPeriodEnd(subscription.stripeSubscriptionId || subscription.providerSubscriptionId || '');
      const updated = await this.prisma.subscription.update({
        where: { id: subscription.id },
        data: { cancelAtPeriodEnd: true },
      });
      return { success: true, subscription: updated };
    }

    const updated = await this.prisma.subscription.update({
      where: { id: subscription.id },
      data: {
        status: SubscriptionStatus.CANCELLED,
        canceledAt: new Date(),
      },
    });
    await this.syncLegacyPlan(updated.userId, updated.companyId, 'COMMON');
    return { success: true, subscription: updated };
  }

  async changePlan(user: AuthUser, input: ChangePlanInput) {
    const userId = this.resolveUserId(user);
    const planKey = normalizeBillingPlanKey(input.targetPlanKey || input.planKey);
    const billingCycle = normalizeBillingCycle(input.billingCycle || input.billingInterval);
    if (!planKey || !billingCycle) {
      throw new BadRequestException({ code: 'INVALID_PLAN', message: 'Plano invalido.' });
    }

    const companyId = await this.resolveCompanyIdForUser(userId, input.companyId, user.companyId || null);
    if (!companyId) {
      throw new BadRequestException({ code: 'COMPANY_REQUIRED', message: 'Selecione uma empresa para alterar o plano.' });
    }

    const targetPlan = await this.prisma.billingPlan.findUnique({
      where: { key: planKey },
      include: { prices: { where: { billingCycle, isActive: true } } },
    });
    const targetPrice = targetPlan?.prices[0];
    const stripePriceId = this.getStripePriceId(planKey, billingCycle);
    if (!targetPlan || !targetPrice || !stripePriceId) {
      throw new NotFoundException({ code: 'PLAN_PRICE_UNAVAILABLE', message: 'Este plano esta indisponivel no momento.' });
    }

    const current = await this.ensureEntitledSubscriptionForUser(userId, companyId);
    if (!this.isSubscriptionActive(current)) {
      const checkout = await this.createCheckout(user, {
        planKey,
        billingCycle,
        companyId,
      });
      return {
        status: 'checkout_required',
        checkoutUrl: checkout.checkoutUrl,
        message: 'Finalize sua assinatura em um ambiente seguro.',
      };
    }

    if (current?.planKey === planKey && current.billingCycle === billingCycle) {
      return {
        status: 'changed',
        billing: await this.getBillingForUser(userId, companyId),
        message: 'Este plano ja esta ativo.',
      };
    }

    const stripeSubscriptionId = current?.stripeSubscriptionId || current?.providerSubscriptionId;
    if (!stripeSubscriptionId || current.provider !== 'STRIPE') {
      return {
        status: 'portal_required',
        message: 'Abra o ambiente seguro de assinatura para concluir esta alteracao.',
      };
    }

    const stripeSubscription = await this.stripeService.retrieveSubscription(stripeSubscriptionId);
    const stripeItemId = this.subscriptionItemId(stripeSubscription);
    if (!stripeItemId) {
      return {
        status: 'portal_required',
        message: 'Abra o ambiente seguro de assinatura para concluir esta alteracao.',
      };
    }

    const metadata = {
      userId,
      companyId,
      planKey: this.toPublicPlanKey(planKey),
      billingCycle,
      billingInterval: this.toStripeInterval(billingCycle),
      source: 'next_level_ai',
      localSubscriptionId: current.id,
    };

    const updatedSubscription = await this.stripeService.updateSubscriptionPrice({
      subscriptionId: stripeSubscriptionId,
      subscriptionItemId: stripeItemId,
      priceId: stripePriceId,
      metadata,
    });
    await this.applyStripeSubscription(updatedSubscription);

    this.logger.log(JSON.stringify({
      event: 'billing.stripe.subscription.plan_changed',
      userId,
      companyId,
      subscriptionId: current.id,
      planKey,
      billingCycle,
      prorationBehavior: 'create_prorations',
    }));

    const billing = await this.getBillingForUser(userId, companyId);
    return {
      status: billing.hasActiveSubscription ? 'changed' : 'pending_confirmation',
      billing,
      message: billing.hasActiveSubscription
        ? 'Plano atualizado com sucesso.'
        : 'Alteracao recebida. Estamos confirmando sua assinatura.',
    };
  }

  async handleStripeWebhook(rawBody: Buffer | undefined, signature: string | undefined) {
    const event = this.stripeService.constructWebhookEvent(rawBody, signature);
    const eventId = `STRIPE:${event.id}`;
    this.logger.log(JSON.stringify({
      event: 'billing.stripe.webhook.received',
      stripeEventId: event.id,
      type: event.type,
      livemode: event.livemode,
    }));
    const existing = await this.prisma.paymentEvent.findUnique({ where: { eventId } });
    if (existing) {
      this.logger.log(JSON.stringify({
        event: 'billing.stripe.webhook.duplicate',
        stripeEventId: event.id,
        type: event.type,
        processed: existing.processed,
      }));
      return { received: true, duplicated: true, processed: existing.processed };
    }

    const paymentEvent = await this.prisma.paymentEvent.create({
      data: {
        eventId,
        stripeEventId: event.id,
        eventType: event.type,
        provider: 'STRIPE',
        providerEventId: event.id,
        providerObjectId: this.objectId(event.data.object),
        providerRawEventType: event.type,
        apiVersion: null,
        devMode: !event.livemode,
        rawPayload: event as unknown as Prisma.InputJsonValue,
      },
    });

    try {
      await this.processStripeEvent(event);
      await this.prisma.paymentEvent.update({
        where: { id: paymentEvent.id },
        data: { processed: true, processedAt: new Date() },
      });
      return { received: true };
    } catch (error) {
      const message = this.extractMessage(error);
      await this.prisma.paymentEvent.update({
        where: { id: paymentEvent.id },
        data: {
          processingError: message,
          processedAt: new Date(),
        },
      });
      this.logger.error(`Falha ao processar webhook Stripe ${event.type}: ${message}`);
      return { received: true, processed: false };
    }
  }

  async findActiveSubscriptionForGuard(userId: string, companyId?: string | null) {
    const subscription = await this.ensureEntitledSubscriptionForUser(userId, companyId);
    return this.isSubscriptionActive(subscription) ? subscription : null;
  }

  private async processStripeEvent(event: StripeWebhookEventRecord) {
    if (event.type === 'checkout.session.completed') {
      await this.handleCheckoutCompleted(event.data.object as StripeCheckoutSessionRecord);
      return;
    }

    if (
      event.type === 'customer.subscription.created' ||
      event.type === 'customer.subscription.updated' ||
      event.type === 'customer.subscription.deleted'
    ) {
      await this.applyStripeSubscription(event.data.object as StripeSubscriptionRecord);
      return;
    }

    if (event.type === 'invoice.paid') {
      const invoice = event.data.object as StripeInvoiceLike;
      const stripeSubscriptionId = this.invoiceSubscriptionId(invoice);
      if (stripeSubscriptionId) {
        const subscription = await this.stripeService.retrieveSubscription(stripeSubscriptionId);
        await this.applyStripeSubscription(subscription, SubscriptionStatus.ACTIVE);
      }
      return;
    }

    if (event.type === 'invoice.payment_failed') {
      const invoice = event.data.object as StripeInvoiceLike;
      const stripeSubscriptionId = this.invoiceSubscriptionId(invoice);
      if (stripeSubscriptionId) {
        const subscription = await this.stripeService.retrieveSubscription(stripeSubscriptionId);
        await this.applyStripeSubscription(subscription, SubscriptionStatus.PAST_DUE);
      }
      return;
    }

    if (event.type === 'payment_intent.succeeded') {
      this.logger.log(JSON.stringify({ event: 'billing.stripe.payment_intent.succeeded', stripeEventId: event.id }));
      return;
    }

    if (event.type === 'entitlements.active_entitlement_summary.updated') {
      this.logger.log(JSON.stringify({ event: 'billing.stripe.entitlements.updated', stripeEventId: event.id }));
    }
  }

  private async handleCheckoutCompleted(session: StripeCheckoutSessionRecord) {
    const stripeSubscriptionId = this.asStripeId(session.subscription);
    if (!stripeSubscriptionId) return;

    const subscription = await this.stripeService.retrieveSubscription(stripeSubscriptionId);
    await this.applyStripeSubscription(subscription, undefined, session);
  }

  private async applyStripeSubscription(
    stripeSubscription: StripeSubscriptionRecord,
    statusOverride?: SubscriptionStatus,
    checkoutSession?: StripeCheckoutSessionRecord,
  ) {
    const stripeSub = stripeSubscription as StripeSubscriptionLike;
    const metadata = {
      ...(stripeSub.metadata || {}),
      ...(checkoutSession?.metadata || {}),
    };
    const localSubscriptionId = this.stringValue(metadata.localSubscriptionId);
    const stripeCustomerId = this.asStripeId(stripeSub.customer) || this.asStripeId(checkoutSession?.customer);
    const stripeSubscriptionId = stripeSub.id;
    const stripePriceId = this.subscriptionPriceId(stripeSub);
    const planKey = normalizeBillingPlanKey(metadata.planKey) || this.planKeyFromStripePrice(stripePriceId);
    const billingCycle =
      normalizeBillingCycle(metadata.billingCycle || metadata.billingInterval) ||
      this.billingCycleFromStripeSubscription(stripeSub);
    const userId = this.stringValue(metadata.userId);
    const companyId = this.stringValue(metadata.companyId);

    if (!planKey || !billingCycle) {
      throw new BadRequestException('Webhook Stripe sem plano reconhecido.');
    }

    const billingPlan = await this.ensureBillingPlan(planKey);
    const existing = await this.findStripeLocalSubscription({
      localSubscriptionId,
      stripeSubscriptionId,
      checkoutSessionId: checkoutSession?.id || null,
    });
    const baseUserId = existing?.userId || userId;
    const baseCompanyId = existing?.companyId || companyId;
    if (!baseUserId || !baseCompanyId) {
      throw new BadRequestException('Webhook Stripe sem empresa ou usuario local.');
    }

    const status = statusOverride || this.mapStripeSubscriptionStatus(stripeSub.status);
    const amountInCents = this.amountForPlan(planKey, billingCycle);
    const currentPeriodStart = this.unixToDate(stripeSub.current_period_start);
    const currentPeriodEnd = this.unixToDate(stripeSub.current_period_end);
    const canceledAt = this.unixToDate(stripeSub.canceled_at);

    const data = {
      userId: baseUserId,
      companyId: baseCompanyId,
      billingPlanId: billingPlan.id,
      planKey,
      billingCycle,
      status,
      provider: 'STRIPE',
      source: 'STRIPE',
      providerSubscriptionId: stripeSubscriptionId,
      providerCustomerId: stripeCustomerId || undefined,
      providerCheckoutId: checkoutSession?.id || existing?.providerCheckoutId || undefined,
      providerProductId: stripePriceId || undefined,
      stripeSubscriptionId,
      stripeCustomerId: stripeCustomerId || undefined,
      stripeCheckoutSessionId: checkoutSession?.id || existing?.stripeCheckoutSessionId || undefined,
      stripePriceId: stripePriceId || undefined,
      stripeStatus: stripeSub.status,
      cancelAtPeriodEnd: Boolean(stripeSub.cancel_at_period_end),
      currentPeriodStart,
      currentPeriodEnd,
      paidAt: ACTIVE_SUBSCRIPTION_STATUSES.includes(status) ? new Date() : existing?.paidAt || undefined,
      canceledAt: status === SubscriptionStatus.CANCELLED ? canceledAt || new Date() : undefined,
      amountInCents,
      currency: String(existing?.currency || 'BRL').toUpperCase(),
      providerMetadata: {
        stripeSubscriptionStatus: stripeSub.status,
        stripePriceId,
        checkoutSessionId: checkoutSession?.id || null,
      } as Prisma.InputJsonValue,
      metadata: {
        planKey,
        billingCycle,
        source: 'stripe_webhook',
        companyId: baseCompanyId,
      } as Prisma.InputJsonValue,
    };

    const updated = existing
      ? await this.prisma.subscription.update({ where: { id: existing.id }, data })
      : await this.prisma.subscription.create({ data });

    this.logger.log(JSON.stringify({
      event: 'billing.stripe.subscription.synced',
      subscriptionId: updated.id,
      userId: updated.userId,
      companyId: updated.companyId,
      planKey: updated.planKey,
      billingCycle: updated.billingCycle,
      status: updated.status,
      stripeCustomerId,
      stripeSubscriptionId,
      checkoutSessionId: checkoutSession?.id || null,
    }));

    if (stripeCustomerId) {
      await this.prisma.company.update({
        where: { id: baseCompanyId },
        data: { stripeCustomerId },
      });
    }

    if (ACTIVE_SUBSCRIPTION_STATUSES.includes(updated.status)) {
      await this.syncLegacyPlan(updated.userId, updated.companyId, updated.planKey);
    } else if (this.isBlockingStatus(updated.status)) {
      await this.syncLegacyPlan(updated.userId, updated.companyId, 'COMMON');
    }
  }

  private async findStripeLocalSubscription(input: {
    localSubscriptionId?: string | null;
    stripeSubscriptionId?: string | null;
    checkoutSessionId?: string | null;
  }) {
    if (input.localSubscriptionId) {
      const byLocal = await this.prisma.subscription.findUnique({
        where: { id: input.localSubscriptionId },
      });
      if (byLocal) return byLocal;
    }

    if (input.stripeSubscriptionId) {
      const byStripe = await this.prisma.subscription.findFirst({
        where: {
          OR: [
            { stripeSubscriptionId: input.stripeSubscriptionId },
            { providerSubscriptionId: input.stripeSubscriptionId },
          ],
        },
        orderBy: { createdAt: 'desc' },
      });
      if (byStripe) return byStripe;
    }

    if (input.checkoutSessionId) {
      const byCheckout = await this.prisma.subscription.findFirst({
        where: {
          OR: [
            { stripeCheckoutSessionId: input.checkoutSessionId },
            { providerCheckoutId: input.checkoutSessionId },
          ],
        },
        orderBy: { createdAt: 'desc' },
      });
      if (byCheckout) return byCheckout;
    }

    return null;
  }

  private async ensureEntitledSubscriptionForUser(userId: string, companyId?: string | null) {
    const activeByCompany = companyId ? await this.findActiveSubscriptionForCompany(companyId) : null;
    if (activeByCompany) return activeByCompany;

    if (!companyId) {
      const active = await this.findActiveSubscription(userId);
      if (active) return active;
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, plan: true, companyId: true, admin: true },
    });
    if (!user) return companyId ? this.findLatestSubscriptionForCompany(companyId) : this.findLatestSubscription(userId);

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

    const latestCompanySubscription = companyId ? await this.findLatestSubscriptionForCompany(companyId) : null;
    if (latestCompanySubscription) return latestCompanySubscription;

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

    return companyId ? null : this.findLatestSubscription(userId);
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
        name: 'Pro Business',
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
        name: labels[planKey].name,
        isActive: true,
      },
    });
  }

  private async getOrCreateStripeCustomer(input: {
    companyId: string;
    currentCustomerId?: string | null;
    companyName: string;
    userEmail?: string | null;
    userName?: string | null;
  }) {
    if (input.currentCustomerId) return input.currentCustomerId;

    const customer = await this.stripeService.createCustomer({
      email: input.userEmail || undefined,
      name: input.companyName || input.userName || undefined,
      metadata: {
        companyId: input.companyId,
        app: 'next_level_ai',
      },
    });

    await this.prisma.company.update({
      where: { id: input.companyId },
      data: { stripeCustomerId: customer.id },
    });

    return customer.id;
  }

  private async getAiUsageSummary(companyId: string, planKey: BillingPlanKey) {
    const now = new Date();
    const yearMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    const rows = await this.prisma.companyAIUsageMonthly.findMany({
      where: { companyId, yearMonth },
      select: { feature: true, requestCount: true, tokenCount: true },
    });
    return {
      yearMonth,
      planKey,
      usage: rows,
      limits: this.planEntitlements.getEntitlements(planKey).quotas,
    };
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

  private isBlockingStatus(status: SubscriptionStatus) {
    const blockingStatuses: SubscriptionStatus[] = [
      SubscriptionStatus.CANCELLED,
      SubscriptionStatus.EXPIRED,
      SubscriptionStatus.REFUNDED,
      SubscriptionStatus.FAILED,
      SubscriptionStatus.DISPUTED,
      SubscriptionStatus.LOST,
      SubscriptionStatus.PAST_DUE,
      SubscriptionStatus.INCOMPLETE,
      SubscriptionStatus.UNPAID,
    ];
    return blockingStatuses.includes(status);
  }

  private mapStripeSubscriptionStatus(status: string): SubscriptionStatus {
    const normalized = String(status || '').toLowerCase();
    if (normalized === 'active') return SubscriptionStatus.ACTIVE;
    if (normalized === 'trialing') return SubscriptionStatus.TRIAL;
    if (normalized === 'canceled') return SubscriptionStatus.CANCELLED;
    if (normalized === 'past_due') return SubscriptionStatus.PAST_DUE;
    if (normalized === 'unpaid') return SubscriptionStatus.UNPAID;
    if (normalized === 'incomplete' || normalized === 'incomplete_expired') return SubscriptionStatus.INCOMPLETE;
    return SubscriptionStatus.PENDING;
  }

  private subscriptionPriceId(subscription: StripeSubscriptionLike) {
    const item = subscription.items?.data?.[0];
    const price = item?.price;
    return typeof price?.id === 'string' ? price.id : null;
  }

  private subscriptionItemId(subscription: StripeSubscriptionLike) {
    const item = subscription.items?.data?.[0];
    return typeof item?.id === 'string' ? item.id : null;
  }

  private billingCycleFromStripeSubscription(subscription: StripeSubscriptionLike) {
    const interval = subscription.items?.data?.[0]?.price?.recurring?.interval;
    if (interval === 'year') return BillingCycle.ANNUAL;
    if (interval === 'month') return BillingCycle.MONTHLY;
    return null;
  }

  private invoiceSubscriptionId(invoice: StripeInvoiceLike) {
    return (
      this.asStripeId(invoice.subscription) ||
      this.asStripeId(invoice.parent?.subscription_details?.subscription) ||
      null
    );
  }

  private isCheckoutSessionReadyForReconciliation(session: StripeCheckoutSessionRecord) {
    return (
      session.status === 'complete' ||
      session.payment_status === 'paid' ||
      session.payment_status === 'no_payment_required'
    );
  }

  private isStripeSubscriptionRecord(value: unknown): value is StripeSubscriptionRecord {
    return Boolean(
      value &&
        typeof value === 'object' &&
        typeof (value as { id?: unknown }).id === 'string' &&
        typeof (value as { status?: unknown }).status === 'string',
    );
  }

  private planKeyFromStripePrice(priceId?: string | null) {
    if (!priceId) return null;
    for (const planKey of ['COMMON', 'PREMIUM', 'PRO_BUSINESS'] as BillingPlanKey[]) {
      for (const cycle of [BillingCycle.MONTHLY, BillingCycle.ANNUAL]) {
        if (this.getStripePriceId(planKey, cycle) === priceId) return planKey;
      }
    }
    return null;
  }

  private getStripePriceId(planKey: BillingPlanKey, billingCycle: BillingCycle) {
    const envMap: Record<BillingPlanKey, Record<BillingCycle, string>> = {
      COMMON: {
        MONTHLY: 'STRIPE_PRICE_ESSENTIAL_MONTHLY',
        ANNUAL: 'STRIPE_PRICE_ESSENTIAL_YEARLY',
      },
      PREMIUM: {
        MONTHLY: 'STRIPE_PRICE_PREMIUM_MONTHLY',
        ANNUAL: 'STRIPE_PRICE_PREMIUM_YEARLY',
      },
      PRO_BUSINESS: {
        MONTHLY: 'STRIPE_PRICE_PRO_BUSINESS_MONTHLY',
        ANNUAL: 'STRIPE_PRICE_PRO_BUSINESS_YEARLY',
      },
    };
    return this.configService.get<string>(envMap[planKey][billingCycle])?.trim() || null;
  }

  private areAllStripePricesConfigured() {
    return (['COMMON', 'PREMIUM', 'PRO_BUSINESS'] as BillingPlanKey[]).every((planKey) =>
      [BillingCycle.MONTHLY, BillingCycle.ANNUAL].every((cycle) => Boolean(this.getStripePriceId(planKey, cycle))),
    );
  }

  private hasAnyStripePriceConfigured() {
    return (['COMMON', 'PREMIUM', 'PRO_BUSINESS'] as BillingPlanKey[]).some((planKey) =>
      [BillingCycle.MONTHLY, BillingCycle.ANNUAL].some((cycle) => Boolean(this.getStripePriceId(planKey, cycle))),
    );
  }

  private amountForPlan(planKey: BillingPlanKey, billingCycle: BillingCycle) {
    const entitlements = this.planEntitlements.getEntitlements(planKey);
    return billingCycle === BillingCycle.ANNUAL
      ? entitlements.annualPriceInCents
      : entitlements.monthlyPriceInCents;
  }

  private toStripeInterval(billingCycle: BillingCycle) {
    return billingCycle === BillingCycle.ANNUAL ? 'yearly' : 'monthly';
  }

  private toPublicPlanKey(planKey: BillingPlanKey) {
    if (planKey === 'COMMON') return 'essential';
    if (planKey === 'PREMIUM') return 'premium';
    return 'pro_business';
  }

  private asStripeId(value: unknown) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (value && typeof value === 'object' && 'id' in value) {
      const id = (value as { id?: unknown }).id;
      return typeof id === 'string' ? id : null;
    }
    return null;
  }

  private stringValue(value: unknown) {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  }

  private unixToDate(value?: number | null) {
    return typeof value === 'number' && value > 0 ? new Date(value * 1000) : null;
  }

  private objectId(value: unknown) {
    return this.asStripeId(value);
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

  private get backendUrl() {
    return (
      this.configService.get<string>('BACKEND_URL') ||
      this.configService.get<string>('PUBLIC_API_URL') ||
      this.configService.get<string>('APP_URL') ||
      'http://localhost:3333'
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

  private addDays(date: Date, days: number) {
    const clone = new Date(date);
    clone.setUTCDate(clone.getUTCDate() + days);
    return clone;
  }

  private extractMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
}
