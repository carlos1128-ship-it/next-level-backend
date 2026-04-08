import { PrismaClient } from '@prisma/client';
import { Prisma } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('🔍 Verificando estrutura do banco de dados...\n');

  // Tenta limpar usando query raw SQL
  console.log('🧹 Limpando campos whatsappSessionName e whatsappWid...\n');

  try {
    // Verifica e limpa whatsappSessionName
    const checkSessionName = await prisma.$queryRawUnsafe<Record<string, any>[]>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'Company' AND column_name = 'whatsappSessionName'`
    );

    if (checkSessionName.length > 0) {
      console.log('✅ Coluna whatsappSessionName encontrada');
      const result = await prisma.$executeRawUnsafe(
        `UPDATE "Company" SET "whatsappSessionName" = NULL WHERE "whatsappSessionName" IS NOT NULL`
      );
      console.log(`   → ${result} registro(s) atualizado(s)\n`);
    } else {
      console.log('❌ Coluna whatsappSessionName NÃO EXISTE no banco\n');
    }

    // Verifica e limpa whatsappWid
    const checkWid = await prisma.$queryRawUnsafe<Record<string, any>[]>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'Company' AND column_name = 'whatsappWid'`
    );

    if (checkWid.length > 0) {
      console.log('✅ Coluna whatsappWid encontrada');
      const result = await prisma.$executeRawUnsafe(
        `UPDATE "Company" SET "whatsappWid" = NULL WHERE "whatsappWid" IS NOT NULL`
      );
      console.log(`   → ${result} registro(s) atualizado(s)\n`);
    } else {
      console.log('❌ Coluna whatsappWid NÃO EXISTE no banco\n');
    }

    // Lista todas as empresas
    const companies = await prisma.$queryRawUnsafe<Record<string, any>[]>(
      `SELECT id, name, "whatsappSessionName", "whatsappWid" FROM "Company"`
    );

    console.log(`📊 Total de empresas: ${companies.length}`);
    companies.forEach((c, i) => {
      console.log(`   ${i + 1}. ${c.name} (${c.id})`);
      console.log(`      whatsappSessionName: ${c.whatsappSessionName || 'NULL'}`);
      console.log(`      whatsappWid: ${c.whatsappWid || 'NULL'}`);
    });

  } catch (error) {
    console.error('Erro:', error);
    throw error;
  }
}

main()
  .then(() => {
    console.log('\n✅ Script finalizado com sucesso!');
  })
  .catch((e) => {
    console.error('\n❌ Erro ao executar script:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
