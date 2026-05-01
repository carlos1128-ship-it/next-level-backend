import assert from 'assert';
import {
  AIUsageFeature,
  AIUsageProvider,
  AIUsageStatus,
  Plan,
  Prisma,
} from '@prisma/client';
import { AiService } from '../src/modules/ai/ai.service';
import { AIUsageLimitExceededException } from '../src/modules/usage/ai-usage-limit.exception';
import { AIUsageService } from '../src/modules/usage/ai-usage.service';
import { WhatsappConnectionsService } from '../src/modules/whatsapp/services/whatsapp-connections.service';

type MonthlyKey = string;

function monthlyKey(companyId: string, yearMonth: string, feature: AIUsageFeature): MonthlyKey {
  return `${companyId}:${yearMonth}:${feature}`;
}

function createUsagePrisma() {
  const logs: any[] = [];
  const monthly = new Map<MonthlyKey, any>();
  const limits = new Map<string, any>();
  const companies = new Map([
    ['companyA', { id: 'companyA', userId: 'userA', users: [] }],
    ['companyB', { id: 'companyB', userId: 'userB', users: [] }],
  ]);
  const users = new Map([
    ['userA', { id: 'userA', plan: Plan.COMUM }],
    ['userB', { id: 'userB', plan: Plan.COMUM }],
  ]);

  return {
    logs,
    monthly,
    limits,
    prisma: {
      company: {
        findUnique: async ({ where }: any) => companies.get(where.id) || null,
      },
      user: {
        findUnique: async ({ where }: any) => users.get(where.id) || null,
      },
      aIUsageLog: {
        create: async ({ data }: any) => {
          const created = { id: `log-${logs.length + 1}`, createdAt: new Date(), ...data };
          logs.push(created);
          return created;
        },
        findMany: async ({ where }: any) => logs.filter((item) => item.companyId === where.companyId),
        count: async ({ where }: any) => logs.filter((item) => item.companyId === where.companyId).length,
      },
      aIUsageLimit: {
        findMany: async ({ where }: any) =>
          [...limits.values()].filter((item) => item.planKey === where.planKey),
        findUnique: async ({ where }: any) =>
          limits.get(`${where.planKey_feature.planKey}:${where.planKey_feature.feature}`) || null,
      },
      companyAIUsageMonthly: {
        findMany: async ({ where }: any) =>
          [...monthly.values()].filter((item) => item.companyId === where.companyId && item.yearMonth === where.yearMonth),
        findUnique: async ({ where }: any) => {
          const key = monthlyKey(
            where.companyId_yearMonth_feature.companyId,
            where.companyId_yearMonth_feature.yearMonth,
            where.companyId_yearMonth_feature.feature,
          );
          return monthly.get(key) || null;
        },
        upsert: async ({ where, create, update }: any) => {
          const key = monthlyKey(
            where.companyId_yearMonth_feature.companyId,
            where.companyId_yearMonth_feature.yearMonth,
            where.companyId_yearMonth_feature.feature,
          );
          const existing = monthly.get(key);
          if (!existing) {
            const created = {
              id: `usage-${monthly.size + 1}`,
              ...create,
              estimatedCost: create.estimatedCost || new Prisma.Decimal(0),
            };
            monthly.set(key, created);
            return created;
          }

          const updated = {
            ...existing,
            requestCount: existing.requestCount + (update.requestCount?.increment || 0),
            tokenCount: existing.tokenCount + (update.tokenCount?.increment || 0),
            estimatedCost: existing.estimatedCost.plus(update.estimatedCost?.increment || 0),
          };
          monthly.set(key, updated);
          return updated;
        },
      },
      usageQuota: {
        upsert: async () => ({}),
      },
    },
  };
}

async function assertUsageServiceCore() {
  const { prisma, logs, monthly } = createUsagePrisma();
  const usage = new AIUsageService(prisma as never);

  await usage.logUsage(
    'companyA',
    AIUsageFeature.CHAT_IA,
    AIUsageProvider.GEMINI,
    'gemini-2.5-flash',
    { totalTokens: 120 },
    AIUsageStatus.SUCCESS,
    { source: 'test_chat' },
    { userId: 'userA' },
  );
  assert.equal(logs.at(-1).feature, AIUsageFeature.CHAT_IA);

  await usage.logUsage(
    'companyA',
    AIUsageFeature.WHATSAPP_AGENT,
    AIUsageProvider.UNKNOWN,
    'n8n-agent',
    { requestCount: 1 },
    AIUsageStatus.SUCCESS,
    { source: 'test_whatsapp' },
  );
  assert.equal(logs.at(-1).feature, AIUsageFeature.WHATSAPP_AGENT);

  const yearMonth = usage.getCurrentYearMonth();
  assert.equal(monthly.get(monthlyKey('companyA', yearMonth, AIUsageFeature.CHAT_IA)).requestCount, 1);
  assert.equal(monthly.get(monthlyKey('companyA', yearMonth, AIUsageFeature.CHAT_IA)).tokenCount, 120);

  await usage.logUsage(
    'companyB',
    AIUsageFeature.CHAT_IA,
    AIUsageProvider.GEMINI,
    'gemini-2.5-flash',
    { totalTokens: 5 },
    AIUsageStatus.SUCCESS,
  );
  const companyAUsage = await usage.getMonthlyUsage('companyA', yearMonth);
  assert.equal(
    companyAUsage.features.find((item) => item.feature === 'chat_ia')?.requestCount,
    1,
  );

  const belowLimit = await usage.checkLimit('companyA', AIUsageFeature.CHAT_IA);
  assert.equal(belowLimit.allowed, true);

  monthly.set(monthlyKey('companyA', yearMonth, AIUsageFeature.CHAT_IA), {
    id: 'usage-limit',
    companyId: 'companyA',
    yearMonth,
    feature: AIUsageFeature.CHAT_IA,
    requestCount: 500,
    tokenCount: 0,
    estimatedCost: new Prisma.Decimal(0),
  });
  const aboveLimit = await usage.checkLimit('companyA', AIUsageFeature.CHAT_IA);
  assert.equal(aboveLimit.allowed, false);
}

async function assertChatLogsUsage() {
  let providerCalled = false;
  let loggedFeature: AIUsageFeature | null = null;
  const ai = new AiService(
    { get: (key: string) => (key === 'GEMINI_API_KEY' ? 'fake' : undefined) } as never,
    {
      usageQuota: {
        upsert: async () => ({ currentTier: Plan.COMUM, llmTokensUsed: 0 }),
      },
    } as never,
    {
      enforceLimit: async () => ({ allowed: true }),
      logUsage: async (_companyId: string, feature: AIUsageFeature) => {
        loggedFeature = feature;
        return {};
      },
    } as never,
  );
  (ai as any).genAI = {
    getGenerativeModel: () => ({
      generateContent: async () => {
        providerCalled = true;
        return {
          response: {
            text: () => 'resposta',
            usageMetadata: { totalTokenCount: 42 },
          },
        };
      },
    }),
  };

  await ai.generateText('pergunta', 'companyA', 'simple', {
    feature: AIUsageFeature.CHAT_IA,
    userId: 'userA',
  });
  assert.equal(providerCalled, true);
  assert.equal(loggedFeature, AIUsageFeature.CHAT_IA);
}

async function assertBlockedCallDoesNotReachProvider() {
  let providerCalled = false;
  const ai = new AiService(
    { get: (key: string) => (key === 'GEMINI_API_KEY' ? 'fake' : undefined) } as never,
    {} as never,
    {
      enforceLimit: async () => {
        throw new AIUsageLimitExceededException();
      },
      logUsage: async () => ({}),
    } as never,
  );
  (ai as any).genAI = {
    getGenerativeModel: () => ({
      generateContent: async () => {
        providerCalled = true;
        return { response: { text: () => 'nao deveria chamar' } };
      },
    }),
  };

  await assert.rejects(
    () => ai.generateText('pergunta', 'companyA', 'simple', { feature: AIUsageFeature.CHAT_IA }),
    (error: unknown) => error instanceof AIUsageLimitExceededException,
  );
  assert.equal(providerCalled, false);
}

async function assertWhatsappLogsUsage() {
  let loggedFeature: AIUsageFeature | null = null;
  const service = new WhatsappConnectionsService(
    {
      message: {
        findFirst: async () => null,
      },
      businessEvent: {
        create: async () => ({}),
      },
    } as never,
    { get: () => null } as never,
    {} as never,
    {
      get: async () => ({
        id: 'cfg-companyA',
        companyId: 'companyA',
        agentName: 'Atendente',
        tone: 'consultivo',
        toneOfVoice: 'consultivo',
        companyDescription: 'Empresa A',
        welcomeMessage: 'oi',
        instructions: 'prompt',
        systemPrompt: 'prompt',
        internetSearchEnabled: false,
        speechToTextEnabled: false,
        imageUnderstandingEnabled: false,
        pauseForHuman: false,
        debounceSeconds: 3,
        maxContextMessages: 20,
        splitRepliesEnabled: false,
        messageBufferEnabled: true,
        isEnabled: true,
        modelProvider: 'gemini',
        modelName: 'gemini-2.5-flash',
      }),
    } as never,
    {} as never,
    {
      enforceLimit: async () => ({ allowed: true }),
      logUsage: async (_companyId: string, feature: AIUsageFeature) => {
        loggedFeature = feature;
        return {};
      },
    } as never,
  );

  (service as any).forwardIncomingWhatsappMessageToN8n = async () => undefined;
  await (service as any).handleIncomingAutomationMessage(
    { id: 'waA', companyId: 'companyA', instanceName: 'instA', status: 'connected' },
    {
      data: {
        key: {
          remoteJid: '5511999999999@s.whatsapp.net',
          fromMe: false,
          id: 'msg-A',
        },
        pushName: 'Cliente',
        message: { conversation: 'oi' },
      },
    },
  );

  assert.equal(loggedFeature, AIUsageFeature.WHATSAPP_AGENT);
}

async function main() {
  await assertUsageServiceCore();
  await assertChatLogsUsage();
  await assertWhatsappLogsUsage();
  await assertBlockedCallDoesNotReachProvider();
  console.log('AI usage checks passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
