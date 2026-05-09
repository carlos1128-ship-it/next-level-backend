import { SetMetadata } from '@nestjs/common';
import { BillingPlanKey } from '../constants/billing.constants';

export const REQUIRED_PLAN_KEY = 'billing:requiredPlan';
export const SKIP_SUBSCRIPTION_CHECK_KEY = 'billing:skipSubscriptionCheck';

export const RequirePlan = (plan: BillingPlanKey) =>
  SetMetadata(REQUIRED_PLAN_KEY, plan);

export const SkipSubscriptionCheck = () =>
  SetMetadata(SKIP_SUBSCRIPTION_CHECK_KEY, true);
