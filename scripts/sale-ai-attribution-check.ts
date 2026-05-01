import {
  IntegrationProvider,
  PrismaClient,
  SaleAIAttributionSource,
} from '@prisma/client';
import { SalesService } from '../src/modules/sales/sales.service';
import { AttendantService } from '../src/modules/attendant/attendant.service';

const prisma = new PrismaClient();
const slugs = ['sale-ai-attribution-a', 'sale-ai-attribution-b'];
const emails = ['sale-ai-attribution-a@nextlevel.local', 'sale-ai-attribution-b@nextlevel.local'];

function assert(condition: unknown, message: string) {
  if (!condition) {
    throw new Error(message);
  }
}

async function reset() {
  await prisma.company.deleteMany({ where: { slug: { in: slugs } } });
  await prisma.user.deleteMany({ where: { email: { in: emails } } });
}

async function createCompany(index: number) {
  const user = await prisma.user.create({
    data: {
      email: emails[index],
      password: 'validation-only',
      name: `Attribution User ${index + 1}`,
      plan: 'PRO',
    },
  });
  const company = await prisma.company.create({
    data: {
      userId: user.id,
      name: `Attribution Company ${index + 1}`,
      slug: slugs[index],
    },
  });
  await prisma.user.update({ where: { id: user.id }, data: { companyId: company.id } });

  const conversation = await prisma.conversation.create({
    data: {
      companyId: company.id,
      contactNumber: `551199999100${index}`,
      remoteJid: `551199999100${index}@s.whatsapp.net`,
      status: 'IA respondeu',
      lastMessageAt: new Date(),
    },
  });
  const aiMessage = await prisma.message.create({
    data: {
      companyId: company.id,
      conversationId: conversation.id,
      role: 'assistant',
      direction: 'outbound',
      content: 'Resposta da IA que levou a venda.',
      status: 'sent',
    },
  });
  const outboundAutomationMessage = await prisma.message.create({
    data: {
      companyId: company.id,
      conversationId: conversation.id,
      direction: 'outbound',
      content: 'Mensagem via n8n',
      aiResponse: 'Mensagem via n8n',
      status: 'sent',
    },
  });

  return { user, company, conversation, aiMessage, outboundAutomationMessage };
}

async function main() {
  if (process.env.NODE_ENV === 'production' && process.env.SALE_AI_ATTRIBUTION_TEST_ALLOW_PRODUCTION !== '1') {
    throw new Error('Recusado em production. Defina SALE_AI_ATTRIBUTION_TEST_ALLOW_PRODUCTION=1 para executar conscientemente.');
  }

  await reset();
  const [a, b] = await Promise.all([createCompany(0), createCompany(1)]);
  const sales = new SalesService(prisma as any);
  const attendant = new AttendantService(
    prisma as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
  );

  const saleA = await sales.create(a.user.id, {
    amount: 1200,
    productName: 'Venda atribuida A',
    category: 'WhatsApp',
    occurredAt: new Date().toISOString(),
    aiAttribution: {
      conversationId: a.conversation.id,
      messageId: a.aiMessage.id,
      source: SaleAIAttributionSource.WHATSAPP_AGENT,
      attributedRevenue: 900,
      confidence: 0.95,
      metadata: { provider: IntegrationProvider.WHATSAPP },
    },
  });
  assert(saleA?.aiAttribution?.attributedRevenue && Number(saleA.aiAttribution.attributedRevenue) === 900, 'A. Venda A nao recebeu atribuicao fina');

  const saleB = await sales.create(b.user.id, {
    amount: 500,
    productName: 'Venda atribuida B',
    category: 'WhatsApp',
    occurredAt: new Date().toISOString(),
    aiAttribution: {
      conversationId: b.conversation.id,
      messageId: b.outboundAutomationMessage.id,
      source: SaleAIAttributionSource.WHATSAPP_AGENT,
      attributedRevenue: 500,
      confidence: 1,
    },
  });
  assert(saleB?.aiAttribution?.messageId === b.outboundAutomationMessage.id, 'B. Mensagem outbound com aiResponse nao foi aceita');

  const roiA = await attendant.getRoi(a.company.id);
  const roiB = await attendant.getRoi(b.company.id);
  assert(roiA.iaSalesCount === 1 && roiA.iaRevenue === 900, 'C. ROI A nao veio da tabela de atribuicao');
  assert(roiB.iaSalesCount === 1 && roiB.iaRevenue === 500, 'D. ROI B nao ficou isolado');

  let blockedSaleAccess = false;
  try {
    await sales.attributeSale(a.user.id, saleB!.id, {
      conversationId: a.conversation.id,
      messageId: a.aiMessage.id,
      attributedRevenue: 1,
    });
  } catch {
    blockedSaleAccess = true;
  }
  assert(blockedSaleAccess, 'E. Empresa A conseguiu atribuir venda da Empresa B');

  let blockedConversationLeak = false;
  try {
    await sales.attributeSale(a.user.id, saleA!.id, {
      conversationId: b.conversation.id,
      messageId: a.aiMessage.id,
      attributedRevenue: 1,
    });
  } catch {
    blockedConversationLeak = true;
  }
  assert(blockedConversationLeak, 'F. Empresa A conseguiu usar conversa da Empresa B');

  await sales.attributeSale(a.user.id, saleA!.id, {
    conversationId: a.conversation.id,
    messageId: a.aiMessage.id,
    source: SaleAIAttributionSource.MANUAL_REVIEW,
    attributedRevenue: 1000,
    confidence: 1,
  });
  const attributionCountA = await prisma.saleAIAttribution.count({
    where: { companyId: a.company.id, saleId: saleA!.id },
  });
  const updatedRoiA = await attendant.getRoi(a.company.id);
  assert(attributionCountA === 1, 'G. Atribuicao duplicou em vez de atualizar');
  assert(updatedRoiA.iaSalesCount === 1 && updatedRoiA.iaRevenue === 1000, 'H. ROI A nao refletiu upsert de atribuicao');

  console.log('Sale AI attribution checks A-H passed.');
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
