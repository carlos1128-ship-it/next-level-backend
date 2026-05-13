import { IntegrationProvider, PrismaClient } from '@prisma/client';
import { AttendantActionService } from '../src/modules/attendant-actions/attendant-action.service';
import { AttendantContextService } from '../src/modules/attendant-actions/attendant-context.service';
import { AttendantDataExtractionService } from '../src/modules/attendant-actions/attendant-data-extraction.service';
import { AttendantIntentService } from '../src/modules/attendant-actions/attendant-intent.service';

const prisma = new PrismaClient();
const slug = 'social-automation-check';
const email = 'social-automation-check@nextlevel.local';

function assert(condition: unknown, message: string) {
  if (!condition) {
    throw new Error(message);
  }
}

async function reset() {
  await prisma.company.deleteMany({ where: { slug } });
  await prisma.user.deleteMany({ where: { email } });
}

async function main() {
  if (process.env.NODE_ENV === 'production' && process.env.SOCIAL_AUTOMATION_TEST_ALLOW_PRODUCTION !== '1') {
    throw new Error('Recusado em production. Defina SOCIAL_AUTOMATION_TEST_ALLOW_PRODUCTION=1 para executar conscientemente.');
  }

  await reset();

  const user = await prisma.user.create({
    data: {
      email,
      password: 'validation-only',
      name: 'Social Automation Check',
      plan: 'PRO',
    },
  });
  const company = await prisma.company.create({
    data: {
      userId: user.id,
      name: 'Social Automation Company',
      slug,
    },
  });
  await prisma.user.update({ where: { id: user.id }, data: { companyId: company.id } });
  await prisma.agentConfig.create({
    data: {
      companyId: company.id,
      agentName: 'Next Level',
      tone: 'objetivo',
      toneOfVoice: 'objetivo',
      companyDescription: 'Empresa de teste',
      welcomeMessage: 'Ola',
      instructions: 'Responda com clareza.',
      systemPrompt: 'Atenda com seguranca.',
    },
  });

  const whatsappConversation = await prisma.conversation.create({
    data: {
      companyId: company.id,
      provider: IntegrationProvider.WHATSAPP,
      channel: 'whatsapp',
      contactNumber: '5511999999999',
      remoteJid: '5511999999999@s.whatsapp.net',
      contactName: 'Ana Cliente',
      status: 'open',
      lastMessageAt: new Date(),
    },
  });

  const instagramConversation = await prisma.conversation.create({
    data: {
      companyId: company.id,
      provider: IntegrationProvider.INSTAGRAM,
      channel: 'instagram',
      contactNumber: 'instagram:sender-1',
      remoteJid: 'sender-1',
      status: 'Aguardando',
      lastMessageAt: new Date(),
    },
  });

  const service = new AttendantActionService(
    prisma as any,
    new AttendantIntentService(),
    new AttendantDataExtractionService(),
    new AttendantContextService(prisma as any),
  );

  const saleResult = await service.analyzeAndPrepare({
    companyId: company.id,
    conversationId: whatsappConversation.id,
    sourceMessageId: 'wa-sale-1',
    channel: 'whatsapp',
    provider: IntegrationProvider.WHATSAPP,
    customerExternalId: '5511999999999@s.whatsapp.net',
    customerPhone: '5511999999999',
    customerName: 'Ana Cliente',
    text: 'Pagamento confirmado do pedido 1234 de R$ 197,00 para Kit Premium.',
  });
  assert(saleResult.saleId, 'A. Venda WhatsApp nao criou Sale');
  assert(saleResult.financialTransactionId, 'B. Venda WhatsApp nao criou FinancialTransaction');
  assert(saleResult.customerId, 'C. Venda WhatsApp nao criou/atualizou Customer');

  await service.analyzeAndPrepare({
    companyId: company.id,
    conversationId: whatsappConversation.id,
    sourceMessageId: 'wa-sale-1',
    channel: 'whatsapp',
    provider: IntegrationProvider.WHATSAPP,
    customerExternalId: '5511999999999@s.whatsapp.net',
    customerPhone: '5511999999999',
    customerName: 'Ana Cliente',
    text: 'Pagamento confirmado do pedido 1234 de R$ 197,00 para Kit Premium.',
  });

  const [saleCount, incomeCount, customerCount] = await Promise.all([
    prisma.sale.count({ where: { companyId: company.id, externalId: 'whatsapp:1234' } }),
    prisma.financialTransaction.count({ where: { companyId: company.id, source: 'whatsapp', externalId: 'whatsapp:1234' } }),
    prisma.customer.count({ where: { companyId: company.id, phone: '5511999999999' } }),
  ]);
  assert(saleCount === 1, 'D. Reprocessar mensagem duplicou Sale');
  assert(incomeCount === 1, 'E. Reprocessar mensagem duplicou FinancialTransaction');
  assert(customerCount === 1, 'F. Reprocessar mensagem duplicou Customer');

  const appointment = await service.analyzeAndPrepare({
    companyId: company.id,
    conversationId: whatsappConversation.id,
    sourceMessageId: 'wa-agenda-1',
    channel: 'whatsapp',
    provider: IntegrationProvider.WHATSAPP,
    customerExternalId: '5511999999999@s.whatsapp.net',
    customerPhone: '5511999999999',
    customerName: 'Ana Cliente',
    text: 'Quero agendar uma consulta amanha as 14h.',
  });
  assert(appointment.appointmentRequestId, 'G. Agenda WhatsApp nao criou AppointmentRequest');

  const instagramLead = await service.analyzeAndPrepare({
    companyId: company.id,
    conversationId: instagramConversation.id,
    sourceMessageId: 'ig-lead-1',
    channel: 'instagram',
    provider: IntegrationProvider.INSTAGRAM,
    customerExternalId: 'sender-1',
    text: 'Oi, quero orcamento para consultoria.',
  });
  assert(instagramLead.customerId, 'H. Lead Instagram nao criou Customer');
  assert(instagramLead.leadId, 'I. Lead Instagram nao criou Lead');

  const [signals, events, memories] = await Promise.all([
    prisma.customerSignal.count({ where: { companyId: company.id } }),
    prisma.businessEvent.count({ where: { companyId: company.id } }),
    prisma.businessMemory.count({ where: { companyId: company.id } }),
  ]);
  assert(signals >= 3, 'J. Sinais de atendimento nao foram gravados');
  assert(events >= 2, 'K. Eventos de negocio nao foram gravados');
  assert(memories >= 3, 'L. Memoria/contexto de IA nao foi atualizado');

  console.log('Social automation checks A-L passed.');
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await reset();
    await prisma.$disconnect();
  });
