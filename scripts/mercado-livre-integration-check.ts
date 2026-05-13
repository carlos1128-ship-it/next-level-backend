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
]);

assertIncludes('src/modules/mercado-livre/mercado-livre-sync.service.ts', [
  'syncProducts',
  'syncOrders',
  'syncQuestions',
  'syncReviews',
  'FinancialTransactionType.INCOME',
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

console.log('Mercado Livre integration checklist OK');
