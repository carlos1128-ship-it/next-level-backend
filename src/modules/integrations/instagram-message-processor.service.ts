import { Injectable, Logger } from '@nestjs/common';
import {
  AIUsageFeature,
  AgentConfig,
  Conversation,
  IntegrationProvider,
  Prisma,
} from '@prisma/client';
import { AiService } from '../ai/ai.service';
import { RagService } from '../ai/rag.service';
import { AlertsService } from '../alerts/alerts.service';
import { PrismaService } from '../../prisma/prisma.service';
import { InstagramIntegrationService } from './instagram-integration.service';
import { InstagramSendService } from './instagram-send.service';

export type NormalizedInstagramMessage = {
  entryId?: string | null;
  instagramAccountId?: string | null;
  pageId?: string | null;
  senderId: string;
  recipientId: string;
  messageId: string;
  text: string;
  timestamp: string;
  contentType: 'text' | 'attachment' | 'unsupported';
  raw: Record<string, unknown>;
};

type ProcessOptions = {
  dryRun?: boolean;
  source?: 'webhook' | 'internal_test';
  retryExistingInbound?: boolean;
};

@Injectable()
export class InstagramMessageProcessorService {
  private readonly logger = new Logger(InstagramMessageProcessorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly aiService: AiService,
    private readonly ragService: RagService,
    private readonly alertsService: AlertsService,
    private readonly instagramIntegrationService: InstagramIntegrationService,
    private readonly instagramSendService: InstagramSendService,
  ) {}

  async processIntegrationEvent(eventId: string, options: ProcessOptions = {}) {
    const claimed = await this.prisma.integrationEvent.updateMany({
      where: {
        id: eventId,
        provider: IntegrationProvider.INSTAGRAM,
        processed: false,
        status: { in: ['received', 'failed'] },
      },
      data: {
        status: 'processing',
        errorMessage: null,
      },
    });

    if (!claimed.count) {
      return { processed: false, skipped: true };
    }

    const event = await this.prisma.integrationEvent.findUnique({
      where: { id: eventId },
    });

    const normalized = this.readStoredNormalizedMessage(event?.payload);
    if (!event || !normalized) {
      await this.finishEvent(eventId, 'ignored', 'Mensagem Instagram ausente no evento');
      return { processed: false, ignored: true };
    }

    try {
      const result = await this.processNormalizedMessage(normalized, {
        source: 'webhook',
        retryExistingInbound: options.retryExistingInbound,
      });
      await this.finishEvent(eventId, result.status, this.readResultError(result));
      return result;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Falha ao processar DM Instagram';
      await this.finishEvent(eventId, 'failed', message);
      this.logger.warn(
        JSON.stringify({
          event: 'instagram.dm.process_failed',
          integrationEventId: eventId,
          message,
        }),
      );
      return { processed: false, status: 'failed', errorMessage: message };
    }
  }

  async processSyntheticMessage(input: {
    companyId: string;
    senderId: string;
    text: string;
    dryRun?: boolean;
  }) {
    const normalized: NormalizedInstagramMessage = {
      instagramAccountId: null,
      pageId: null,
      senderId: input.senderId,
      recipientId: 'internal-test',
      messageId: `internal-test:${Date.now()}:${input.senderId}`,
      text: input.text,
      timestamp: new Date().toISOString(),
      contentType: 'text',
      raw: {
        source: 'internal_test',
        senderId: input.senderId,
      },
    };

    return this.processNormalizedMessage(normalized, {
      dryRun: input.dryRun !== false,
      source: 'internal_test',
    }, input.companyId);
  }

  async reprocessIntegrationEvent(eventId: string) {
    const event = await this.prisma.integrationEvent.findUnique({
      where: { id: eventId },
    });

    const normalized = this.readStoredNormalizedMessage(event?.payload);
    if (!event || event.provider !== IntegrationProvider.INSTAGRAM || !normalized) {
      return {
        processed: false,
        matched: false,
        status: 'ignored',
        errorMessage: 'Evento Instagram inexistente ou payload invalido',
      };
    }

    const resolution =
      await this.instagramIntegrationService.resolveAccountForWebhookDetailed({
        instagramAccountId: normalized.instagramAccountId,
        pageId: normalized.pageId,
        recipientId: normalized.recipientId,
        entryId: normalized.entryId,
      });

    if (!resolution.account) {
      await this.prisma.integrationEvent.update({
        where: { id: eventId },
        data: {
          companyId: null,
          status: 'unresolved',
          processed: false,
          errorMessage: resolution.unresolvedReason || 'Empresa nao resolvida',
        },
      });

      this.logger.warn(
        JSON.stringify({
          event: 'instagram.company.resolve.started',
          recipientId: normalized.recipientId || null,
          entryId: normalized.entryId || null,
          entryIdExists: Boolean(normalized.entryId),
          knownIdFieldsChecked: resolution.knownIdFieldsChecked,
          matched: false,
          matchedBy: null,
          unresolvedReason: resolution.unresolvedReason || null,
        }),
      );

      return {
        processed: false,
        matched: false,
        status: 'unresolved',
        recipientId: normalized.recipientId,
        matchedBy: null,
        unresolvedReason: resolution.unresolvedReason,
      };
    }

    this.logger.log(
      JSON.stringify({
        event: 'instagram.company.resolve.started',
        recipientId: normalized.recipientId || null,
        entryId: normalized.entryId || null,
        entryIdExists: Boolean(normalized.entryId),
        knownIdFieldsChecked: resolution.knownIdFieldsChecked,
        matched: true,
        matchedBy: resolution.matchedBy,
        companyId: resolution.account.companyId,
        integrationAccountId: resolution.account.id,
      }),
    );

    await this.prisma.integrationEvent.update({
      where: { id: eventId },
      data: {
        companyId: resolution.account.companyId,
        status: 'received',
        processed: false,
        errorMessage: null,
        processedAt: null,
      },
    });

    const result = await this.processIntegrationEvent(eventId, {
      retryExistingInbound: true,
    });
    return {
      matched: true,
      matchedBy: resolution.matchedBy,
      companyId: resolution.account.companyId,
      integrationAccountId: resolution.account.id,
      result,
    };
  }

  private async processNormalizedMessage(
    message: NormalizedInstagramMessage,
    options: ProcessOptions = {},
    companyIdOverride?: string,
  ) {
    const account = companyIdOverride
      ? null
      : await this.instagramIntegrationService.resolveAccountForWebhook({
          instagramAccountId: message.instagramAccountId,
          pageId: message.pageId,
          recipientId: message.recipientId,
          entryId: message.entryId,
        });
    const companyId = companyIdOverride || account?.companyId;

    if (!companyId) {
      this.logger.warn(
        JSON.stringify({
          event: 'instagram.dm.company_unresolved',
          instagramAccountId: message.instagramAccountId || null,
          recipientId: message.recipientId || null,
          entryIdExists: Boolean(message.entryId),
          messageId: message.messageId,
        }),
      );
      return {
        processed: false,
        status: 'unresolved',
        errorMessage: 'Empresa nao resolvida para Instagram',
      };
    }

    const conversation = await this.upsertConversation(companyId, message);
    const inbound = await this.createInboundMessage(companyId, conversation.id, message);

    if (!inbound.created && !options.retryExistingInbound) {
      return {
        processed: true,
        status: 'duplicate',
        conversationId: conversation.id,
        messageId: inbound.messageId,
      };
    }

    if (message.contentType !== 'text' || !message.text.trim()) {
      await this.prisma.conversation.update({
        where: { id: conversation.id },
        data: {
          status: 'Aguardando humano',
          lastMessagePreview: '[Instagram: anexo recebido]',
          lastMessageAt: new Date(message.timestamp),
        },
      });
      return {
        processed: true,
        status: 'ignored',
        conversationId: conversation.id,
        reason: 'attachment_or_empty_text',
      };
    }

    const config = await this.getOrCreateAgentConfig(companyId);
    const pauseState = this.resolvePauseState(conversation, config);

    if (pauseState.paused) {
      await this.prisma.conversation.update({
        where: { id: conversation.id },
        data: {
          status: pauseState.status,
          lastMessageAt: new Date(message.timestamp),
        },
      });
      return {
        processed: true,
        status: 'human_required',
        conversationId: conversation.id,
        reason: pauseState.reason,
      };
    }

    const reply = await this.generateAiReply(companyId, conversation.id, message, config);

    if (reply.toUpperCase().includes('PAUSAR_BOT')) {
      const transferMessage = 'Um momento. Vou chamar um atendente humano.';
      await this.pauseConversation(conversation, message.senderId);
      return this.createAndMaybeSendOutbound({
        companyId,
        conversationId: conversation.id,
        recipientId: message.senderId,
        text: transferMessage,
        dryRun: options.dryRun,
        source: options.source,
        statusAfterSend: 'Humano acionado',
      });
    }

    return this.createAndMaybeSendOutbound({
      companyId,
      conversationId: conversation.id,
      recipientId: message.senderId,
      text: reply,
      dryRun: options.dryRun,
      source: options.source,
      statusAfterSend: options.dryRun ? 'IA preview' : 'IA respondeu',
    });
  }

  private async upsertConversation(
    companyId: string,
    message: NormalizedInstagramMessage,
  ) {
    const contactNumber = this.buildInstagramContactKey(message.senderId);
    const timestamp = new Date(message.timestamp);

    return this.prisma.conversation.upsert({
      where: {
        companyId_contactNumber: {
          companyId,
          contactNumber,
        },
      },
      update: {
        provider: IntegrationProvider.INSTAGRAM,
        channel: 'instagram',
        remoteJid: message.senderId,
        externalThreadId: message.senderId,
        externalAccountId: message.instagramAccountId || message.recipientId,
        lastMessagePreview: message.text || '[Instagram: anexo recebido]',
        lastMessageAt: timestamp,
        status: 'Aguardando',
      },
      create: {
        companyId,
        provider: IntegrationProvider.INSTAGRAM,
        channel: 'instagram',
        contactNumber,
        remoteJid: message.senderId,
        externalThreadId: message.senderId,
        externalAccountId: message.instagramAccountId || message.recipientId,
        lastMessagePreview: message.text || '[Instagram: anexo recebido]',
        lastMessageAt: timestamp,
        status: 'Aguardando',
      },
    });
  }

  private async createInboundMessage(
    companyId: string,
    conversationId: string,
    message: NormalizedInstagramMessage,
  ) {
    const existing = await this.prisma.message.findUnique({
      where: {
        companyId_provider_externalMessageId: {
          companyId,
          provider: IntegrationProvider.INSTAGRAM,
          externalMessageId: message.messageId,
        },
      },
      select: { id: true },
    });

    if (existing) {
      return { created: false, messageId: existing.id };
    }

    const created = await this.prisma.message.create({
      data: {
        companyId,
        conversationId,
        provider: IntegrationProvider.INSTAGRAM,
        channel: 'instagram',
        externalMessageId: message.messageId,
        content: message.text,
        text: message.text,
        role: 'user',
        direction: 'inbound',
        contentType: message.contentType,
        status: 'received',
        senderPhone: message.senderId,
        timestamp: new Date(message.timestamp),
        metadata: this.toJson({
          provider: 'instagram',
          channel: 'instagram',
          senderId: message.senderId,
          recipientId: message.recipientId,
          instagramAccountId: message.instagramAccountId,
          entryId: message.entryId,
        }),
        rawPayload: this.toJson(message.raw),
      },
    });

    return { created: true, messageId: created.id };
  }

  private async createAndMaybeSendOutbound(input: {
    companyId: string;
    conversationId: string;
    recipientId: string;
    text: string;
    dryRun?: boolean;
    source?: string;
    statusAfterSend: string;
  }) {
    const outbound = await this.prisma.message.create({
      data: {
        companyId: input.companyId,
        conversationId: input.conversationId,
        provider: IntegrationProvider.INSTAGRAM,
        channel: 'instagram',
        content: input.text,
        text: input.text,
        aiResponse: input.text,
        role: 'assistant',
        direction: 'outbound',
        contentType: 'text',
        status: input.dryRun ? 'dry_run' : 'pending',
        timestamp: new Date(),
        metadata: this.toJson({
          provider: 'instagram',
          channel: 'instagram',
          dryRun: Boolean(input.dryRun),
          source: input.source || 'webhook',
        }),
      },
    });

    if (!input.dryRun) {
      await this.instagramSendService.sendInstagramMessage(
        input.companyId,
        input.recipientId,
        input.text,
        { messageId: outbound.id },
      );
    }

    await this.prisma.conversation.update({
      where: { id: input.conversationId },
      data: {
        status: input.statusAfterSend,
        lastMessagePreview: input.text,
        lastMessageAt: new Date(),
      },
    });

    return {
      processed: true,
      status: input.dryRun ? 'dry_run' : 'sent',
      conversationId: input.conversationId,
      outboundMessageId: outbound.id,
      aiResponse: input.text,
    };
  }

  private async generateAiReply(
    companyId: string,
    conversationId: string,
    currentMessage: NormalizedInstagramMessage,
    config: AgentConfig,
  ) {
    const historyLimit = Math.max(1, config.maxContextMessages || 20);
    const [company, history, rag] = await Promise.all([
      this.prisma.company.findUnique({
        where: { id: companyId },
        select: { name: true, description: true },
      }),
      this.prisma.message.findMany({
        where: {
          conversationId,
          provider: IntegrationProvider.INSTAGRAM,
        },
        orderBy: { timestamp: 'desc' },
        take: historyLimit,
      }),
      this.ragService.buildContext(companyId, currentMessage.text).catch(() => ''),
    ]);

    const prompt = this.buildPrompt({
      agentName: config.agentName,
      companyName: company?.name || 'sua empresa',
      companyDescription:
        config.companyDescription || company?.description || 'Empresa sem descricao cadastrada.',
      systemPrompt: config.systemPrompt,
      toneOfVoice: config.toneOfVoice || config.tone,
      instructions: config.instructions,
      welcomeMessage: config.welcomeMessage,
      customerMessage: currentMessage.text,
      history: history.reverse().map((item) => ({
        role: item.role,
        content: item.content,
      })),
      rag,
    });

    const result = await this.aiService.generateText(prompt, companyId, 'simple', {
      feature: AIUsageFeature.INSTAGRAM_AGENT,
      metadata: {
        source: 'instagram_dm_pipeline',
        channel: 'instagram',
        conversationId,
      },
    });

    return result.text.trim() || config.welcomeMessage || 'Oi! Como posso ajudar?';
  }

  private buildPrompt(input: {
    agentName: string;
    companyName: string;
    companyDescription: string;
    systemPrompt: string;
    toneOfVoice: string;
    instructions: string;
    welcomeMessage: string;
    customerMessage: string;
    history: Array<{ role: string; content: string }>;
    rag: string;
  }) {
    const historyText = input.history.length
      ? input.history.map((item) => `${item.role}: ${item.content}`).join('\n')
      : 'Sem historico anterior no Instagram.';

    return [
      `Voce e ${input.agentName}, atendente virtual da empresa ${input.companyName}.`,
      'Canal atual: instagram.',
      `Descricao da empresa: ${input.companyDescription}`,
      `Tom de voz: ${input.toneOfVoice}.`,
      'Fale sempre em portugues do Brasil.',
      'Responda como a atendente configurada do negocio, de forma curta e clara para DM.',
      'Nao invente preco, estoque, prazo ou politica. Se faltar dado, diga que vai confirmar com um humano.',
      'Se o cliente pedir humano ou a conversa exigir humano, responda somente com PAUSAR_BOT.',
      `Mensagem inicial/regras: ${input.welcomeMessage}`,
      `System prompt configurado: ${input.systemPrompt}`,
      `Instrucoes da empresa: ${input.instructions}`,
      `Contexto de negocio:\n${input.rag || 'Sem contexto adicional.'}`,
      `Historico recente do Instagram:\n${historyText}`,
      `Mensagem atual do cliente: ${input.customerMessage}`,
    ].join('\n\n');
  }

  private async getOrCreateAgentConfig(companyId: string) {
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { name: true, description: true, sector: true, segment: true },
    });

    return this.prisma.agentConfig.upsert({
      where: { companyId },
      update: {},
      create: {
        companyId,
        agentName: 'Atendente Next Level',
        companyDescription:
          company?.description ||
          [company?.name, company?.sector, company?.segment].filter(Boolean).join(' - '),
        welcomeMessage: 'Oi! Sou o atendimento da Next Level. Como posso ajudar?',
        systemPrompt:
          'Voce responde com clareza, nao inventa informacoes e transfere para humano quando necessario.',
        toneOfVoice: 'consultivo',
        internetSearchEnabled: false,
        isEnabled: false,
        pauseForHuman: true,
        speechToTextEnabled: false,
        imageUnderstandingEnabled: false,
        splitRepliesEnabled: false,
        messageBufferEnabled: true,
        debounceSeconds: 3,
        maxContextMessages: 20,
        modelProvider: 'openai',
        modelName: 'gpt-4o-mini',
      },
    });
  }

  private resolvePauseState(conversation: Conversation, config: AgentConfig) {
    const now = new Date();
    const conversationPaused =
      conversation.isPaused &&
      (!conversation.pausedUntil || conversation.pausedUntil > now);

    if (conversationPaused) {
      return {
        paused: true,
        status: 'Humano assumiu',
        reason: 'conversation_paused',
      };
    }

    if (!config.isEnabled || !config.isOnline) {
      return {
        paused: true,
        status: 'Aguardando humano',
        reason: 'agent_inactive',
      };
    }

    return { paused: false, status: 'Aguardando', reason: null };
  }

  private async pauseConversation(conversation: Conversation, senderId: string) {
    await this.prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        isPaused: true,
        botPaused: true,
        status: 'Humano assumiu',
        pausedUntil: null,
      },
    });

    await this.alertsService
      .createAlert({
        companyId: conversation.companyId,
        type: 'INSTAGRAM_BOT_HANDOFF',
        severity: 'critical',
        message: `Cliente Instagram ${senderId} precisa de atendimento humano.`,
      })
      .catch(() => null);
  }

  private readStoredNormalizedMessage(payload: Prisma.JsonValue | undefined) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return null;
    }

    const normalized = (payload as Record<string, unknown>)['normalized'];
    if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)) {
      return null;
    }

    const item = normalized as Record<string, unknown>;
    if (
      typeof item.senderId !== 'string' ||
      typeof item.recipientId !== 'string' ||
      typeof item.messageId !== 'string'
    ) {
      return null;
    }

    return {
      instagramAccountId:
        typeof item.instagramAccountId === 'string' ? item.instagramAccountId : null,
      entryId: typeof item.entryId === 'string' ? item.entryId : null,
      pageId: typeof item.pageId === 'string' ? item.pageId : null,
      senderId: item.senderId,
      recipientId: item.recipientId,
      messageId: item.messageId,
      text: typeof item.text === 'string' ? item.text : '',
      timestamp:
        typeof item.timestamp === 'string' ? item.timestamp : new Date().toISOString(),
      contentType:
        item.contentType === 'attachment' || item.contentType === 'unsupported'
          ? item.contentType
          : 'text',
      raw:
        item.raw && typeof item.raw === 'object' && !Array.isArray(item.raw)
          ? (item.raw as Record<string, unknown>)
          : {},
    } satisfies NormalizedInstagramMessage;
  }

  private async finishEvent(
    eventId: string,
    status: string,
    errorMessage?: string | null,
  ) {
    await this.prisma.integrationEvent.update({
      where: { id: eventId },
      data: {
        status,
        processed: true,
        processedAt: new Date(),
        errorMessage: errorMessage || null,
      },
    });
  }

  private readResultError(result: unknown) {
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      return null;
    }

    const errorMessage = (result as Record<string, unknown>).errorMessage;
    return typeof errorMessage === 'string' ? errorMessage : null;
  }

  private buildInstagramContactKey(senderId: string) {
    return `instagram:${senderId}`;
  }

  private toJson(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value ?? {})) as Prisma.InputJsonValue;
  }
}
