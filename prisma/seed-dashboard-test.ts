import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

function daysAgo(days: number, hour = 10) {
  const date = new Date();
  date.setDate(date.getDate() - days);
  date.setHours(hour, 0, 0, 0);
  return date;
}

async function main() {
  if (process.env.NODE_ENV === 'production' || process.env.DASHBOARD_TEST_SEED !== '1') {
    throw new Error('Refusing to seed dashboard data. Set DASHBOARD_TEST_SEED=1 outside production.');
  }

  const company = await prisma.company.upsert({
    where: { slug: 'dashboard-test-company' },
    update: {
      name: 'Dashboard Test Company',
      currency: 'BRL',
      timezone: 'America/Sao_Paulo',
    },
    create: {
      name: 'Dashboard Test Company',
      slug: 'dashboard-test-company',
      currency: 'BRL',
      timezone: 'America/Sao_Paulo',
    },
  });

  const password = await bcrypt.hash('senha123', Number(process.env.BCRYPT_ROUNDS || 10));
  const user = await prisma.user.upsert({
    where: { email: 'dashboard-test@nextlevel.local' },
    update: { companyId: company.id, admin: false },
    create: {
      email: 'dashboard-test@nextlevel.local',
      password,
      name: 'Dashboard Test User',
      companyId: company.id,
    },
  });

  await prisma.$transaction([
    prisma.sale.deleteMany({ where: { companyId: company.id } }),
    prisma.financialTransaction.deleteMany({ where: { companyId: company.id } }),
    prisma.operationalCost.deleteMany({ where: { companyId: company.id } }),
    prisma.adSpend.deleteMany({ where: { companyId: company.id } }),
    prisma.customer.deleteMany({ where: { companyId: company.id } }),
    prisma.product.deleteMany({ where: { companyId: company.id } }),
  ]);

  await prisma.product.createMany({
    data: [
      { companyId: company.id, name: 'Plano Growth', sku: 'PLAN-GROWTH', category: 'SaaS', price: 497, cost: 90 },
      { companyId: company.id, name: 'Consultoria Sprint', sku: 'CONS-SPRINT', category: 'Servicos', price: 1200, cost: 350 },
      { companyId: company.id, name: 'Setup Premium', sku: 'SET-PREMIUM', category: 'Servicos', price: 1800, cost: 500 },
    ],
  });

  await prisma.customer.createMany({
    data: [
      { companyId: company.id, name: 'Cliente Alfa', email: 'alfa@example.com', createdAt: daysAgo(2, 9) },
      { companyId: company.id, name: 'Cliente Beta', email: 'beta@example.com', createdAt: daysAgo(8, 11) },
      { companyId: company.id, name: 'Cliente Gama', email: 'gama@example.com', createdAt: daysAgo(18, 14) },
    ],
  });

  await prisma.sale.createMany({
    data: [
      { userId: user.id, companyId: company.id, amount: 497, productName: 'Plano Growth', category: 'SaaS', occurredAt: daysAgo(1, 10) },
      { userId: user.id, companyId: company.id, amount: 1200, productName: 'Consultoria Sprint', category: 'Servicos', occurredAt: daysAgo(3, 15) },
      { userId: user.id, companyId: company.id, amount: 1800, productName: 'Setup Premium', category: 'Servicos', occurredAt: daysAgo(12, 16) },
      { userId: user.id, companyId: company.id, amount: 497, productName: 'Plano Growth', category: 'SaaS', occurredAt: daysAgo(24, 9) },
    ],
  });

  await prisma.financialTransaction.createMany({
    data: [
      { userId: user.id, companyId: company.id, type: 'INCOME', amount: 750, description: 'Receita avulsa', category: 'Servicos', occurredAt: daysAgo(5, 13) },
      { userId: user.id, companyId: company.id, type: 'EXPENSE', amount: 280, description: 'Ferramentas', category: 'Software', occurredAt: daysAgo(4, 12) },
      { userId: user.id, companyId: company.id, type: 'EXPENSE', amount: 420, description: 'Freelancer', category: 'Operacao', occurredAt: daysAgo(15, 12) },
    ],
  });

  await prisma.operationalCost.createMany({
    data: [
      { companyId: company.id, name: 'Hospedagem', category: 'Infra', amount: 180, date: daysAgo(2, 10) },
      { companyId: company.id, name: 'Atendimento', category: 'Equipe', amount: 650, date: daysAgo(7, 10) },
      { companyId: company.id, name: 'Ferramentas internas', category: 'Software', amount: 220, date: daysAgo(20, 10) },
    ],
  });

  await prisma.adSpend.createMany({
    data: [
      { companyId: company.id, amount: 300, source: 'meta', spentAt: daysAgo(6, 10) },
      { companyId: company.id, amount: 150, source: 'google', spentAt: daysAgo(16, 10) },
    ],
  });

  console.log('Dashboard seed ready: dashboard-test@nextlevel.local / senha123');
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
