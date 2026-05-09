import { CanActivate, ExecutionContext, HttpException, Injectable, HttpStatus } from '@nestjs/common';
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

    const request = context.switchToHttp().getRequest<{ user?: RequestUser }>();
    const user = request.user;
    const userId = user?.id || user?.userId || user?.sub;
    if (!userId) return true;

    const subscription = await this.billingService.findActiveSubscriptionForGuard(userId);
    if (!subscription) {
      throw new HttpException(
        {
          statusCode: HttpStatus.PAYMENT_REQUIRED,
          code: 'SUBSCRIPTION_REQUIRED',
          message: 'É necessário escolher um plano para acessar a plataforma.',
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
      throw new HttpException(
        {
          statusCode: HttpStatus.FORBIDDEN,
          code: 'PLAN_UPGRADE_REQUIRED',
          message: 'Seu plano atual não dá acesso a este recurso.',
        },
        HttpStatus.FORBIDDEN,
      );
    }

    return true;
  }
}
