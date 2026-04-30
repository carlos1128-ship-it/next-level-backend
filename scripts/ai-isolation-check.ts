import assert from 'assert';
import { ForbiddenException } from '@nestjs/common';
import { ActiveCompanyGuard } from '../src/common/guards/active-company.guard';
import {
  buildAgentKey,
  buildBufferKey,
  buildBufferLastKey,
  buildHumanPauseKey,
  buildStrategicChatMemoryKey,
  buildUsageKey,
  buildWhatsappMemoryKey,
} from '../src/common/utils/ai-memory-keys.util';
import { ChatService } from '../src/modules/ai/chat.service';
import { RagService } from '../src/modules/ai/rag.service';
import { WhatsappAgentConfigService } from '../src/modules/whatsapp/services/whatsapp-agent-config.service';
import { WhatsappConnectionsService } from '../src/modules/whatsapp/services/whatsapp-connections.service';

type AgentConfigRecord = {
  id: string;
  companyId: string;
  agentName: string;
  companyDescription: string;
  welcomeMessage: string;
  systemPrompt: string;
  instructions: string;
  tone: string;
  toneOfVoice: string;
  internetSearchEnabled: boolean;
  speechToTextEnabled: boolean;
  imageUnderstandingEnabled: boolean;
  pauseForHuman: boolean;
  debounceSeconds: number;
  maxContextMessages: number;
  splitRepliesEnabled: boolean;
  messageBufferEnabled: boolean;
  isEnabled: boolean;
  modelProvider: string;
  modelName: string;
  createdAt: Date;
  updatedAt: Date;
};

function createAgentConfigPrisma() {
  const companies = new Map([
    ['companyA', { name: 'Empresa A', description: 'A', sector: 'varejo', segment: 'moda' }],
    ['companyB', { name: 'Empresa B', description: 'B', sector: 'servicos', segment: 'consultoria' }],
  ]);
  const configs = new Map<string, AgentConfigRecord>();

  return {
    configs,
    company: {
      findUnique: async ({ where }: { where: { id: string } }) => companies.get(where.id) || null,
    },
    agentConfig: {
      upsert: async ({ where, create }: { where: { companyId: string }; create: AgentConfigRecord }) => {
        const existing = configs.get(where.companyId);
        if (existing) return existing;
        const now = new Date();
        const created = {
          ...create,
          id: `cfg-${where.companyId}`,
          instructions: '',
          tone: create.toneOfVoice,
          createdAt: now,
          updatedAt: now,
        };
        configs.set(where.companyId, created);
        return created;
      },
      update: async ({ where, data }: { where: { companyId?: string; id?: string }; data: Partial<AgentConfigRecord> }) => {
        const key = where.companyId || [...configs.values()].find((item) => item.id === where.id)?.companyId;
        assert.ok(key, 'update precisa resolver companyId');
        const current = configs.get(key);
        assert.ok(current, 'config existente obrigatoria');
        const updated = { ...current, ...data, updatedAt: new Date() };
        configs.set(key, updated);
        return updated;
      },
      findUnique: async ({ where }: { where: { companyId: string } }) => configs.get(where.companyId) || null,
    },
  };
}

async function assertAgentConfigIsolation() {
  const prisma = createAgentConfigPrisma();
  const service = new WhatsappAgentConfigService(prisma as never);

  await service.update('companyA', { systemPrompt: 'A_PROMPT', isEnabled: true } as never);
  await service.update('companyB', { systemPrompt: 'B_PROMPT', isEnabled: true } as never);

  const configA = await service.get('companyA');
  const configB = await service.get('companyB');
  assert.equal(configA.systemPrompt, 'A_PROMPT');
  assert.equal(configB.systemPrompt, 'B_PROMPT');
  assert.notEqual(configA.id, configB.id);

  const defaultConfig = await service.get('companyC');
  assert.equal(defaultConfig.companyId, 'companyC');
}

function assertWhatsappPayloadIsolation() {
  const service = new WhatsappConnectionsService(
    {} as never,
    { get: (key: string) => (key === 'EVOLUTION_BASE_URL' ? 'https://evolution.local' : null) } as never,
    {} as never,
    {} as never,
    {} as never,
  );
  const buildPayload = (service as unknown as {
    buildAutomationPayload: (...args: unknown[]) => Record<string, unknown>;
  }).buildAutomationPayload.bind(service);

  const message = {
    remoteJid: '5511999999999@s.whatsapp.net',
    fromMe: false,
    messageId: 'msg-1',
    pushName: 'Cliente',
    messageType: 'text',
    text: 'oi',
  };

  const configA = {
    id: 'cfgA',
    agentName: 'A',
    tone: 'consultivo',
    companyDescription: 'Empresa A',
    welcomeMessage: 'oi A',
    instructions: 'A_PROMPT',
    systemPrompt: 'A_PROMPT',
    toneOfVoice: 'consultivo',
    internetSearchEnabled: false,
    speechToTextEnabled: false,
    imageUnderstandingEnabled: false,
    pauseForHuman: false,
    debounceSeconds: 3,
    maxContextMessages: 20,
    splitRepliesEnabled: false,
    messageBufferEnabled: true,
    modelProvider: 'gemini',
    modelName: 'gemini-2.5-flash',
  };
  const configB = { ...configA, id: 'cfgB', agentName: 'B', systemPrompt: 'B_PROMPT', instructions: 'B_PROMPT' };

  const payloadA = buildPayload(
    { id: 'waA', companyId: 'companyA', instanceName: 'instA', status: 'connected' },
    { event: 'MESSAGES_UPSERT' },
    message,
    configA,
  );
  const payloadB = buildPayload(
    { id: 'waB', companyId: 'companyB', instanceName: 'instB', status: 'connected' },
    { event: 'MESSAGES_UPSERT' },
    message,
    configB,
  );

  assert.equal((payloadA.agentConfig as Record<string, unknown>).systemPrompt, 'A_PROMPT');
  assert.equal((payloadB.agentConfig as Record<string, unknown>).systemPrompt, 'B_PROMPT');
  assert.equal(payloadA.memoryKey, 'memory:companyA:whatsapp:5511999999999@s.whatsapp.net');
  assert.equal(payloadB.memoryKey, 'memory:companyB:whatsapp:5511999999999@s.whatsapp.net');
  assert.notEqual(payloadA.memoryKey, payloadB.memoryKey);
  assert.equal(payloadA.bufferKey, 'buffer:companyA:5511999999999@s.whatsapp.net');
  assert.equal(payloadA.bufferLastKey, 'buffer:last:companyA:5511999999999@s.whatsapp.net');
  assert.equal(payloadA.humanPauseKey, 'paused:companyA:5511999999999@s.whatsapp.net');
  assert.equal(payloadA.agentKey, 'agent:companyA');
  assert.equal(payloadA.instanceName, 'instA');
  assert.equal(payloadA.fromMe, false);
}

async function assertWhatsappWebhookLoadsConfigByInstanceCompany() {
  const configs = {
    companyA: { systemPrompt: 'A_PROMPT', isEnabled: true },
    companyB: { systemPrompt: 'B_PROMPT', isEnabled: true },
  };
  const forwarded: Array<{ instanceName: string; systemPrompt: string }> = [];
  const service = new WhatsappConnectionsService(
    {
      message: {
        findFirst: async () => null,
      },
    } as never,
    { get: () => null } as never,
    {} as never,
    {
      get: async (companyId: 'companyA' | 'companyB') => ({
        id: `cfg-${companyId}`,
        companyId,
        agentName: companyId,
        tone: 'consultivo',
        toneOfVoice: 'consultivo',
        companyDescription: companyId,
        welcomeMessage: 'oi',
        instructions: configs[companyId].systemPrompt,
        systemPrompt: configs[companyId].systemPrompt,
        internetSearchEnabled: false,
        speechToTextEnabled: false,
        imageUnderstandingEnabled: false,
        pauseForHuman: false,
        debounceSeconds: 3,
        maxContextMessages: 20,
        splitRepliesEnabled: false,
        messageBufferEnabled: true,
        isEnabled: configs[companyId].isEnabled,
        modelProvider: 'gemini',
        modelName: 'gemini-2.5-flash',
      }),
    } as never,
    {} as never,
  );

  (service as unknown as {
    forwardIncomingWhatsappMessageToN8n: (
      connection: { instanceName: string },
      payload: unknown,
      message: unknown,
      agentConfig: { systemPrompt: string },
    ) => Promise<void>;
  }).forwardIncomingWhatsappMessageToN8n = async (connection, _payload, _message, agentConfig) => {
    forwarded.push({ instanceName: connection.instanceName, systemPrompt: agentConfig.systemPrompt });
  };

  const payload = (messageId: string, fromMe = false) => ({
    data: {
      key: {
        remoteJid: '5511999999999@s.whatsapp.net',
        fromMe,
        id: messageId,
      },
      pushName: 'Cliente',
      message: { conversation: 'oi' },
    },
  });

  await (service as unknown as {
    handleIncomingAutomationMessage: (connection: unknown, payload: unknown) => Promise<void>;
  }).handleIncomingAutomationMessage(
    { id: 'waA', companyId: 'companyA', instanceName: 'instA', status: 'connected' },
    payload('msg-A'),
  );
  await (service as unknown as {
    handleIncomingAutomationMessage: (connection: unknown, payload: unknown) => Promise<void>;
  }).handleIncomingAutomationMessage(
    { id: 'waB', companyId: 'companyB', instanceName: 'instB', status: 'connected' },
    payload('msg-B'),
  );
  await (service as unknown as {
    handleIncomingAutomationMessage: (connection: unknown, payload: unknown) => Promise<void>;
  }).handleIncomingAutomationMessage(
    { id: 'waA', companyId: 'companyA', instanceName: 'instA', status: 'connected' },
    payload('msg-from-me', true),
  );

  assert.deepEqual(forwarded, [
    { instanceName: 'instA', systemPrompt: 'A_PROMPT' },
    { instanceName: 'instB', systemPrompt: 'B_PROMPT' },
  ]);
}

async function assertRagCompanyScope() {
  let capturedProductWhere: Record<string, unknown> | null = null;
  const rag = new RagService(
    {
      company: {
        findUnique: async ({ where }: { where: { id: string } }) => ({ id: where.id, name: where.id, currency: 'BRL', timezone: 'America/Sao_Paulo' }),
      },
      product: {
        findMany: async ({ where }: { where: Record<string, unknown> }) => {
          capturedProductWhere = where;
          return where.companyId === 'companyA'
            ? [{ name: 'Produto A', price: 10, cost: 5, tax: 1, shipping: 0, sku: 'A' }]
            : [{ name: 'Produto B', price: 99, cost: 5, tax: 1, shipping: 0, sku: 'B' }];
        },
      },
    } as never,
    {
      getAggregatesByCompanyAndPeriod: async (companyId: string) => {
        assert.equal(companyId, 'companyA');
        return { sales: [], total: 0, byProduct: {} };
      },
    } as never,
    {
      getInsights: async (companyId: string) => {
        assert.equal(companyId, 'companyA');
        return [];
      },
    } as never,
  );

  const context = await rag.buildContext('companyA', 'produto');
  assert.equal(capturedProductWhere?.companyId, 'companyA');
  assert.ok(context.includes('Produto A'));
  assert.ok(!context.includes('Produto B'));
}

async function assertStrategicChatScope() {
  let capturedHistoryWhere: Record<string, unknown> | null = null;
  const prisma = {
    user: {
      findUnique: async () => ({ id: 'userA', companyId: 'companyA', detailLevel: 'medium' }),
    },
    company: {
      findFirst: async ({ where }: { where: { id?: string } }) =>
        where.id === 'companyA' ? { id: 'companyA', name: 'Empresa A', currency: 'BRL', createdAt: new Date() } : null,
    },
    financialTransaction: {
      findMany: async () => [],
    },
    aiChatMessage: {
      findMany: async ({ where }: { where: Record<string, unknown> }) => {
        capturedHistoryWhere = where;
        return [{ role: 'USER', content: 'historico A', createdAt: new Date() }];
      },
      create: async () => ({}),
    },
    $transaction: async (items: Promise<unknown>[]) => Promise.all(items),
  };

  const chat = new ChatService(
    { get: () => undefined } as never,
    prisma as never,
    { getDashboard: async () => ({ totalIncome: 10, totalExpense: 2, balance: 8, transactionsCount: 1 }) } as never,
    { buildContext: async () => '' } as never,
  );

  await chat.chat('userA', { companyId: 'companyA', message: 'Como estou?' });
  assert.deepEqual(capturedHistoryWhere, { companyId: 'companyA', userId: 'userA' });
}

async function assertGuardRejectsCrossCompany() {
  const guard = new ActiveCompanyGuard({} as never);
  const context = {
    switchToHttp: () => ({
      getRequest: () => ({
        user: { id: 'userA', companyId: 'companyA' },
        query: { companyId: 'companyB' },
        body: {},
        params: {},
      }),
    }),
  };

  await assert.rejects(
    () => guard.canActivate(context as never),
    (error: unknown) => error instanceof ForbiddenException,
  );
}

async function main() {
  await assertAgentConfigIsolation();
  assertWhatsappPayloadIsolation();
  await assertWhatsappWebhookLoadsConfigByInstanceCompany();
  await assertRagCompanyScope();
  await assertStrategicChatScope();
  await assertGuardRejectsCrossCompany();

  assert.equal(buildStrategicChatMemoryKey('companyA', 'userA'), 'memory:companyA:user:userA');
  assert.equal(buildWhatsappMemoryKey('companyA', 'remote'), 'memory:companyA:whatsapp:remote');
  assert.equal(buildAgentKey('companyA'), 'agent:companyA');
  assert.equal(buildUsageKey('companyA', '202604'), 'usage:companyA:202604');
  assert.equal(buildBufferKey('companyA', 'remote'), 'buffer:companyA:remote');
  assert.equal(buildBufferLastKey('companyA', 'remote'), 'buffer:last:companyA:remote');
  assert.equal(buildHumanPauseKey('companyA', 'remote'), 'paused:companyA:remote');

  console.log('AI isolation checks passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
