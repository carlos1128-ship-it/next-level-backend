import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();

function read(path: string) {
  const fullPath = join(root, path);
  if (!existsSync(fullPath)) {
    throw new Error(`Arquivo ausente: ${path}`);
  }
  return readFileSync(fullPath, 'utf8');
}

function assertIncludes(path: string, snippets: string[]) {
  const content = read(path);
  for (const snippet of snippets) {
    if (!content.includes(snippet)) {
      throw new Error(`${path} nao contem: ${snippet}`);
    }
  }
}

assertIncludes('prisma/schema.prisma', [
  'model MercadoLivreOAuthToken',
  'model MercadoLivreOrder',
  'model MercadoLivreOrderItem',
  'model MercadoLivreShipment',
  'model MercadoLivreQuestion',
  'model MercadoLivreReview',
  'model MercadoLivreAnalytics',
  'model LGPDLog',
  'model Stock',
  'mercadolivre',
  'accessTokenEncrypted',
]);

assertIncludes('src/modules/mercado-livre/mercado-livre-auth.service.ts', [
  'exchangeCode',
  'refreshToken',
  'accessTokenEncrypted',
  'refreshTokenEncrypted',
  'assertIntegrationAccessForCompany',
  'mercado_livre.oauth.connected',
]);

assertIncludes('src/modules/mercado-livre/mercado-livre-sync.service.ts', [
  'syncProducts',
  'syncOrders',
  'syncQuestions',
  'syncReviews',
  'saleTransactionsUpserted',
  'isRevenueOrder',
  'zeroRevenueRecords',
  'FinancialTransactionType.INCOME',
  'companyId_source_externalId',
]);

assertIncludes('src/modules/mercado-livre/mercado-livre.controller.ts', [
  '@Get(\'sync-status\')',
  '@Post(\'sync-now\')',
  '@Post(\'sync/questions\')',
  'assertIntegrationAccessForCompany',
]);

assertIncludes('src/modules/mercado-livre/mercado-livre-auth.controller.ts', [
  'mercado_livre.initial_sync.started',
  'syncService.syncAll',
]);

assertIncludes('src/modules/mercado-livre/mercado-livre-webhook.controller.ts', [
  '@Controller(\'webhook/ml\')',
  'verifyWebhookSignature',
  'IntegrationProvider.MERCADOLIVRE',
]);

assertIncludes('src/modules/mercado-livre/mercado-livre-cron.service.ts', [
  'EVERY_DAY_AT_MIDNIGHT',
  'EVERY_HOUR',
]);

assertIncludes('src/modules/billing/plan-entitlements.service.ts', [
  'MERCADO_LIVRE_INTEGRATION',
  'PREMIUM',
  'plan.gate.decision',
  'resolveCompanyPlanKey',
]);

assertIncludes('src/modules/billing/billing.service.ts', [
  'billing.checkout.created',
  'billing.webhook.received',
  'billing.subscription.activated',
  'resolveCompanyIdForUser',
]);

assertIncludes('scripts/promote-admin-pro-business.ts', [
  'ADMIN_EMAIL',
  'ADMIN_COMPANY_ID',
  'PRO_BUSINESS',
  'SubscriptionStatus.ACTIVE',
]);

assertIncludes('package.json', [
  '"admin:pro-business": "ts-node scripts/promote-admin-pro-business.ts"',
]);

console.log('Mercado Livre integration checklist OK');
