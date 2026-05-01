import assert from 'assert';
import axios from 'axios';
import { ConflictException } from '@nestjs/common';
import { WhatsappConnectionsService } from '../src/modules/whatsapp/services/whatsapp-connections.service';

type ConnectionRecord = {
  id: string;
  companyId: string;
  provider: string;
  instanceName: string;
  instanceId: string | null;
  instanceToken: string | null;
  status: string;
  connectionState: string;
  qrCode: string | null;
  qrCodeText: string | null;
  pairingCode: string | null;
  phoneNumber: string | null;
  webhookUrl: string | null;
  webhookEnabled: boolean;
  webhookLastConfiguredAt: Date | null;
  webhookLastError: string | null;
  webhookConfigHash: string | null;
  userRequestedDisconnect: boolean;
  sessionGeneration: number;
  lastEvolutionState: string | null;
  lastConnectionEventAt: Date | null;
  lastQrAt: Date | null;
  lastQrGeneratedAt: Date | null;
  lastError: string | null;
  lastConnectionAt: Date | null;
  lastConnectedAt: Date | null;
  lastDisconnectedAt: Date | null;
  lastEvolutionSyncAt: Date | null;
  lastConnectStartAt: Date | null;
  lastQrRequestAt: Date | null;
  lastRepairAt: Date | null;
  providerRetryAfterUntil: Date | null;
  operationLockUntil: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

function createConnection(input: Partial<ConnectionRecord> & { companyId: string; instanceName: string }): ConnectionRecord {
  const now = new Date();
  return {
    id: `wa-${input.companyId}`,
    companyId: input.companyId,
    provider: 'evolution',
    instanceName: input.instanceName,
    instanceId: null,
    instanceToken: null,
    status: 'not_configured',
    connectionState: 'close',
    qrCode: null,
    qrCodeText: null,
    pairingCode: null,
    phoneNumber: null,
    webhookUrl: null,
    webhookEnabled: false,
    webhookLastConfiguredAt: null,
    webhookLastError: null,
    webhookConfigHash: null,
    userRequestedDisconnect: false,
    sessionGeneration: 1,
    lastEvolutionState: null,
    lastConnectionEventAt: null,
    lastQrAt: null,
    lastQrGeneratedAt: null,
    lastError: null,
    lastConnectionAt: null,
    lastConnectedAt: null,
    lastDisconnectedAt: null,
    lastEvolutionSyncAt: null,
    lastConnectStartAt: null,
    lastQrRequestAt: null,
    lastRepairAt: null,
    providerRetryAfterUntil: null,
    operationLockUntil: null,
    createdAt: now,
    updatedAt: now,
    ...input,
  };
}

function createPrismaMock() {
  const companies = new Map([
    ['companyA', { id: 'companyA', name: 'Empresa A' }],
    ['companyB', { id: 'companyB', name: 'Empresa B' }],
  ]);
  const connections = new Map<string, ConnectionRecord>();
  const webhookEvents: unknown[] = [];

  function findConnection(where: { id?: string; companyId?: string; instanceName?: string }) {
    return [...connections.values()].find((item) => {
      if (where.id) return item.id === where.id;
      if (where.companyId) return item.companyId === where.companyId;
      if (where.instanceName) return item.instanceName === where.instanceName;
      return false;
    }) || null;
  }

  return {
    companies,
    connections,
    webhookEvents,
    prisma: {
      company: {
        findUnique: async ({ where }: { where: { id: string } }) => companies.get(where.id) || null,
      },
      whatsappInstance: {
        findUnique: async () => null,
      },
      whatsappConnection: {
        findUnique: async ({ where, select }: { where: { id?: string; companyId?: string; instanceName?: string }; select?: Record<string, boolean> }) => {
          const found = findConnection(where);
          if (!found || !select) return found;
          return Object.fromEntries(
            Object.entries(select)
              .filter(([, enabled]) => enabled)
              .map(([key]) => [key, (found as unknown as Record<string, unknown>)[key]]),
          );
        },
        upsert: async ({ where, update, create }: { where: { companyId: string }; update: Partial<ConnectionRecord>; create: Partial<ConnectionRecord> & { companyId: string; instanceName: string } }) => {
          const existing = findConnection(where);
          if (existing) {
            const updated = { ...existing, ...update, updatedAt: new Date() };
            connections.set(updated.companyId, updated);
            return updated;
          }
          const created = createConnection(create);
          connections.set(created.companyId, created);
          return created;
        },
        update: async ({ where, data }: { where: { id?: string; companyId?: string; instanceName?: string }; data: Partial<ConnectionRecord> }) => {
          const existing = findConnection(where);
          assert.ok(existing, `conexao nao encontrada: ${JSON.stringify(where)}`);
          const updated = { ...existing, ...data, updatedAt: new Date() };
          connections.set(updated.companyId, updated);
          return updated;
        },
      },
      webhookEvent: {
        create: async ({ data }: { data: unknown }) => {
          webhookEvents.push(data);
          return data;
        },
      },
      message: {
        findFirst: async () => null,
      },
      businessEvent: {
        create: async () => ({}),
      },
    },
  };
}

function createProviderMock() {
  const remote = new Map<string, { state: string; phoneNumber: string | null }>();
  const webhooks = new Map<string, { url: string; events: string[] }>();
  const createdInstances: string[] = [];
  const deletedInstances: string[] = [];

  return {
    remote,
    webhooks,
    createdInstances,
    deletedInstances,
    isConfigured: () => true,
    getBaseUrl: () => 'https://evolution.local',
    warmUp: async () => undefined,
    findRemoteInstance: async (instanceName: string) => ({
      exists: remote.has(instanceName),
      state: remote.get(instanceName)?.state || 'close',
      phoneNumber: remote.get(instanceName)?.phoneNumber || null,
    }),
    createInstance: async (
      _companyId: string,
      instanceName: string,
      options?: { webhookUrl?: string; events?: string[] },
    ) => {
      remote.set(instanceName, { state: 'connecting', phoneNumber: null });
      if (options?.webhookUrl) {
        webhooks.set(instanceName, {
          url: options.webhookUrl,
          events: options.events || [],
        });
      }
      createdInstances.push(instanceName);
      return { instanceName };
    },
    getWebhook: async (instanceName: string) => {
      const webhook = webhooks.get(instanceName);
      return webhook ? { enabled: true, url: webhook.url, events: webhook.events } : {};
    },
    setWebhook: async (instanceName: string, webhookUrl: string, events: string[]) => {
      webhooks.set(instanceName, { url: webhookUrl, events });
      return { ok: true };
    },
    connectInstance: async (instanceName: string) => ({
      status: 'qr_pending',
      qrCode: `qr-${instanceName}`,
      code: `qr-text-${instanceName}`,
      pairingCode: null,
      phoneNumber: null,
      count: 1,
    }),
    getConnectionState: async (instanceName: string) => {
      const item = remote.get(instanceName);
      return { state: item?.state || 'close', phoneNumber: item?.phoneNumber || null };
    },
    getInstanceState: async (instanceName: string) => {
      const item = remote.get(instanceName);
      return { state: item?.state || 'close', phoneNumber: item?.phoneNumber || null };
    },
    logoutInstance: async () => undefined,
    deleteInstance: async (instanceName: string) => {
      deletedInstances.push(instanceName);
      remote.delete(instanceName);
    },
    sendTextMessage: async () => ({ ok: true }),
  };
}

const agentConfigService = {
  get: async (companyId: 'companyA' | 'companyB') => ({
    id: `cfg-${companyId}`,
    companyId,
    agentName: companyId === 'companyA' ? 'PROMPT_A_TEST' : 'PROMPT_B_TEST',
    tone: 'consultivo',
    toneOfVoice: 'consultivo',
    companyDescription: companyId,
    welcomeMessage: 'Ola',
    instructions: companyId === 'companyA' ? 'PROMPT_A_TEST' : 'PROMPT_B_TEST',
    systemPrompt: companyId === 'companyA' ? 'PROMPT_A_TEST' : 'PROMPT_B_TEST',
    internetSearchEnabled: false,
    speechToTextEnabled: false,
    imageUnderstandingEnabled: false,
    pauseForHuman: true,
    debounceSeconds: 3,
    maxContextMessages: 20,
    splitRepliesEnabled: false,
    messageBufferEnabled: true,
    isEnabled: true,
    modelProvider: 'gemini',
    modelName: 'gemini-2.5-flash',
  }),
};

async function main() {
  const { prisma, connections, webhookEvents } = createPrismaMock();
  const provider = createProviderMock();
  const n8nPayloads: Array<Record<string, unknown>> = [];
  const originalPost = axios.post;
  (axios as unknown as { post: typeof axios.post }).post = async (_url, payload) => {
    n8nPayloads.push(payload as Record<string, unknown>);
    return { status: 202 } as never;
  };

  try {
    const service = new WhatsappConnectionsService(
      prisma as never,
      {
        get: (key: string) => ({
          BACKEND_URL: 'https://api.nextlevel.test',
          EVOLUTION_BASE_URL: 'https://evolution.local',
          N8N_AGENT_WEBHOOK_URL: 'https://n8n.local/webhook',
          INTERNAL_AUTOMATION_TOKEN: 'internal-test-token',
        })[key],
      } as never,
      provider as never,
      agentConfigService as never,
      { ingestEvolutionMessages: async () => undefined } as never,
      { enforceLimit: async () => ({ allowed: true }), logUsage: async () => ({}) } as never,
    );

    const snapshotA = await service.connect('companyA', {});
    const snapshotB = await service.connect('companyB', {});

    assert.equal(snapshotA.companyId, 'companyA');
    assert.equal(snapshotB.companyId, 'companyB');
    assert.equal(snapshotB.status, 'qr_pending');
    assert.ok(snapshotB.qrCode);
    assert.notEqual(snapshotA.instanceName, snapshotB.instanceName);
    assert.ok(provider.createdInstances.includes(snapshotB.instanceName));
    assert.ok(provider.webhooks.has(snapshotB.instanceName));

    const connectionB = connections.get('companyB');
    assert.ok(connectionB?.instanceToken);
    await service.handleEvolutionWebhook(
      {
        event: 'CONNECTION_UPDATE',
        instance: snapshotB.instanceName,
        data: { state: 'open', ownerJid: '5511888888888@s.whatsapp.net' },
      },
      connectionB.instanceToken,
    );
    const connectedB = await service.getCurrent('companyB');
    assert.equal(connectedB.status, 'connected');
    assert.equal(connectedB.phoneNumber, '5511888888888');

    await service.handleEvolutionWebhook(
      {
        event: 'MESSAGES_UPSERT',
        instance: snapshotB.instanceName,
        data: {
          key: {
            remoteJid: '5511999999999@s.whatsapp.net',
            fromMe: false,
            id: 'msg-company-b',
          },
          pushName: 'Cliente B',
          message: { conversation: 'oi' },
        },
      },
      connectionB.instanceToken,
    );

    assert.equal(webhookEvents.length, 2);
    assert.equal(n8nPayloads.length, 1);
    const payloadB = n8nPayloads[0];
    assert.equal(payloadB.companyId, 'companyB');
    assert.equal(payloadB.instanceName, snapshotB.instanceName);
    assert.equal((payloadB.agentConfig as Record<string, unknown>).systemPrompt, 'PROMPT_B_TEST');
    assert.equal(payloadB.memoryKey, 'memory:companyB:whatsapp:5511999999999@s.whatsapp.net');
    assert.equal(payloadB.bufferKey, 'buffer:companyB:5511999999999@s.whatsapp.net');
    assert.equal(payloadB.bufferLastKey, 'buffer:last:companyB:5511999999999@s.whatsapp.net');
    assert.equal(payloadB.humanPauseKey, 'paused:companyB:5511999999999@s.whatsapp.net');
    assert.equal(payloadB.agentKey, 'agent:companyB');
    assert.equal((payloadB.reply as Record<string, unknown>).instanceName, snapshotB.instanceName);
    assert.notEqual(payloadB.memoryKey, 'memory:companyA:whatsapp:5511999999999@s.whatsapp.net');
    assert.notEqual((payloadB.agentConfig as Record<string, unknown>).systemPrompt, 'PROMPT_A_TEST');

    await assert.rejects(
      () =>
        (service as unknown as {
          resolveInstanceName: (
            companyId: string,
            dto: { instanceName: string },
            existing: { instanceName: string; status: string; userRequestedDisconnect: boolean },
            sessionGeneration: number,
          ) => Promise<string>;
        }).resolveInstanceName(
          'companyB',
          { instanceName: snapshotA.instanceName },
          connections.get('companyB') as ConnectionRecord,
          1,
        ),
      (error: unknown) => error instanceof ConflictException,
    );

    await service.disconnect('companyB');
    assert.equal((await service.getCurrent('companyA')).status, 'qr_pending');
    assert.notEqual((await service.getCurrent('companyA')).status, 'disconnected');

    console.log('WhatsApp tenant isolation checks passed');
  } finally {
    (axios as unknown as { post: typeof axios.post }).post = originalPost;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
