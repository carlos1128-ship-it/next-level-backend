import { CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../../../common/decorators/public.decorator';
import { BillingService } from '../billing.service';
import { hasPlanAccess } from '../constants/billing.constants';
import {
  REQUIRED_PLAN_KEY,
  SKIP_SUBSCRIPTION_CHECK_KEY,
} from '../decorators/require-plan.decorator';

type RequestUser = {
  id?: string;
  userId?: string;
  sub?: string;
  companyId?: string | null;
};

type BillingGuardRequest = {
  user?: RequestUser;
  url?: string;
  originalUrl?: string;
  query?: Record<string, unknown>;
  body?: Record<string, unknown>;
  params?: Record<string, unknown>;
};

@Injectable()
export class SubscriptionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly billingService: BillingService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const skip = this.reflector.getAllAndOverride<boolean>(SKIP_SUBSCRIPTION_CHECK_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (skip) return true;

    const request = context.switchToHttp().getRequest<BillingGuardRequest>();
    const user = request.user;
    const userId = user?.id || user?.userId || user?.sub;
    if (!userId) return true;

    const companyId = this.resolveCompanyId(request);
    const subscription = await this.billingService.findActiveSubscriptionForGuard(userId, companyId);
    if (!subscription) {
      throw new HttpException(
        {
          statusCode: HttpStatus.PAYMENT_REQUIRED,
          code: 'SUBSCRIPTION_REQUIRED',
          message: 'Escolha um plano para continuar usando a plataforma.',
        },
        HttpStatus.PAYMENT_REQUIRED,
      );
    }

    const requiredPlan =
      this.reflector.getAllAndOverride<string>(REQUIRED_PLAN_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) || 'COMMON';

    if (!hasPlanAccess(subscription.planKey, requiredPlan)) {
      const requiredPlanLabel = requiredPlan === 'PREMIUM' ? 'Premium' : 'Pro Business';
      const path = `${request.originalUrl || request.url || ''}`.toLowerCase();
      const message = path.includes('/integrations') || path.includes('/mercado-livre') || path.includes('/meta')
        ? 'Assine Premium para ter integracoes e mais.'
        : `Este recurso esta disponivel a partir do plano ${requiredPlanLabel}.`;
      throw new HttpException(
        {
          statusCode: HttpStatus.FORBIDDEN,
          code: 'PLAN_UPGRADE_REQUIRED',
          currentPlan: subscription.planKey,
          requiredPlan,
          message,
        },
        HttpStatus.FORBIDDEN,
      );
    }

    return true;
  }

  private resolveCompanyId(request: BillingGuardRequest): string | null {
    return (
      this.asString(request.query?.companyId) ||
      this.asString(request.body?.companyId) ||
      this.asString(request.params?.companyId) ||
      this.asString(request.user?.companyId) ||
      null
    );
  }

  private asString(value: unknown): string {
    if (Array.isArray(value)) {
      const first = value.find((item) => typeof item === 'string' && item.trim());
      return typeof first === 'string' ? first.trim() : '';
    }
    return typeof value === 'string' ? value.trim() : '';
  }
}
