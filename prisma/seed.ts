import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  const company = await prisma.company.upsert({
    where: { slug: 'empresa-demo' },
    update: {},
    create: {
      name: 'Empresa Demo',
      slug: 'empresa-demo',
      currency: 'BRL',
      timezone: 'America/Sao_Paulo',
    },
  });

  const hashedPassword = await bcrypt.hash('senha123', 10);
  const adminUser = await prisma.user.upsert({
    where: { email: 'admin@empresa-demo.com' },
    update: {},
    create: {
      email: 'admin@empresa-demo.com',
      password: hashedPassword,
      name: 'Admin Demo',
      companyId: company.id,
    },
  });

  // Vendas de exemplo para o dashboard (hoje, ontem, semana, mês, ano) exibirem dados reais
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
  await prisma.sale.createMany({
    data: [
      { userId: adminUser.id, companyId: company.id, amount: 150.5, productName: 'Produto A', channel: 'manual', occurredAt: today },
      { userId: adminUser.id, companyId: company.id, amount: 89.0, productName: 'Produto B', channel: 'manual', occurredAt: yesterday },
      { userId: adminUser.id, companyId: company.id, amount: 320.0, productName: 'Produto C', category: 'E-commerce', channel: 'manual', occurredAt: new Date(today.getTime() - 3 * 24 * 60 * 60 * 1000) },
    ],
    skipDuplicates: true,
  });

  console.log('Seed concluído. Login: admin@empresa-demo.com / senha123');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
