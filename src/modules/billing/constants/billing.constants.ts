import { BillingCycle, Plan, SubscriptionStatus } from '@prisma/client';

export const BILLING_PLAN_KEYS = ['COMMON', 'PREMIUM', 'PRO_BUSINESS'] as const;
export type BillingPlanKey = (typeof BILLING_PLAN_KEYS)[number];

export const ACTIVE_SUBSCRIPTION_STATUSES: SubscriptionStatus[] = [
  SubscriptionStatus.ACTIVE,
  SubscriptionStatus.PAID,
  SubscriptionStatus.TRIAL,
];

export const PLAN_LEVELS: Record<BillingPlanKey, number> = {
  COMMON: 1,
  PREMIUM: 2,
  PRO_BUSINESS: 3,
};

export const LEGACY_PLAN_BY_BILLING_KEY: Record<BillingPlanKey, Plan> = {
  COMMON: Plan.COMUM,
  PREMIUM: Plan.PRO,
  PRO_BUSINESS: Plan.ENTERPRISE,
};

export function normalizeBillingPlanKey(value: unknown): BillingPlanKey | null {
  const normalized = String(value || '').trim().toUpperCase();
  if (normalized === 'COMUM') return 'COMMON';
  if (normalized === 'ESSENTIAL' || normalized === 'ESSENCIAL') return 'COMMON';
  if (normalized === 'PRO') return 'PREMIUM';
  if (normalized === 'PROBUSINESS' || normalized === 'BUSINESS') return 'PRO_BUSINESS';
  if (normalized === 'ENTERPRISE') return 'PRO_BUSINESS';
  return BILLING_PLAN_KEYS.includes(normalized as BillingPlanKey)
    ? (normalized as BillingPlanKey)
    : null;
}

export function normalizeBillingCycle(value: unknown) {
  const normalized = String(value || '').trim().toUpperCase();
  if (['MONTHLY', 'MONTH', 'MENSAL'].includes(normalized)) return BillingCycle.MONTHLY;
  if (['ANNUAL', 'YEARLY', 'YEAR', 'ANUAL'].includes(normalized)) return BillingCycle.ANNUAL;
  return null;
}

export function hasPlanAccess(currentPlan: string, requiredPlan: string) {
  const current = normalizeBillingPlanKey(currentPlan);
  const required = normalizeBillingPlanKey(requiredPlan);
  if (!current || !required) return false;
  return PLAN_LEVELS[current] >= PLAN_LEVELS[required];
}
