import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  AIUsageFeature,
  IntegrationProvider,
  WhatsappMessageProcessStatus,
} from '@prisma/client';
import { AiService } from '../ai/ai.service';
import { RagService } from '../ai/rag.service';
import { PrismaService } from '../../prisma/prisma.service';
import { MetaIntegrationService } from '../meta/meta.service';
import { InstagramService } from '../integrations/instagram.service';
import { EvolutionService } from '../integrations/evolution.service';
import { AlertsService } from '../alerts/alerts.service';
import { AttendantGateway } from './attendant.gateway';

const HISTORY_LIMIT = 10;
const HUMAN_PAUSE_HOURS = 24;

@Injectable()
export class AttendantService {
  private readonly logger = new Logger(AttendantService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly aiService: AiService,
    private readonly ragService: RagService,
    private readonly metaIntegrationService: MetaIntegrationService,
    private readonly instagramService: InstagramService,
    private readonly evolutionService: EvolutionService,
    private readonly alertsService: AlertsService,
    private readonly attendantGateway: AttendantGateway,
  ) {}

  @OnEvent('webhooks.received')
  async handleWebhook(payload: {
    eventId: string;
    provider: IntegrationProvider;
    companyId?: string | null;
  }) {
    if (
      payload.provider !== IntegrationProvider.WHATSAPP &&
      payload.provider !== IntegrationProvider.INSTAGRAM
    ) {
      return;
    }

    const event = await this.prisma.webhookEvent.findUnique({
      where: { id: payload.eventId },
      select: { payload: true, companyId: true, id: true },
    });

    if (!event?.payload) return;

    const companyId = event.companyId || payload.companyId;
    if (!companyId) return;

    const rawPayload = event.payload as Record<string, unknown>;
    const messages =
      payload.provider === IntegrationProvider.INSTAGRAM
        ? this.extractInstagramMessages(rawPayload)
        : this.extractWhatsappMessages(rawPayload);

    for (const message of messages) {
      await this.processIncomingMessage(
        companyId,
        payload.provider,
        message.from,
        message.text,
        message.name,
      );
    }

    await this.prisma.webhookEvent.update({
      where: { id: event.id },
      data: { processed: true },
    });
  }

  @OnEvent('whatsapp.message.received')
  async handleWhatsappMessage(payload: {
    companyId: string;
    from: string;
    text: string;
    name?: string;
  }) {
    await this.processIncomingMessage(
      payload.companyId,
      IntegrationProvider.WHATSAPP,
      payload.from,
      payload.text,
      payload.name,
    );
  }

  @OnEvent('whatsapp.message.process')
  async handleWhatsappMessageProcess(payload: {
    messageEventId: string;
    companyId: string;
  }) {
    await this.processWhatsappMessageEvent(payload.messageEventId, payload.companyId);
  }

  @OnEvent('whatsapp.status.updated')
  handleWhatsappStatusUpdate(payload: { companyId: string; status: string }) {
    this.attendantGateway.emitWhatsappStatus(payload.companyId, payload.status);
  }

  @OnEvent('whatsapp.qr.generated')
  handleWhatsappQrGenerated(payload: {
    companyId: string;
    qrCode: string;
    attempts: number;
    sessionName: string;
  }) {
    this.attendantGateway.emitWhatsappQr(payload.companyId, payload);
  }

  async getBotConfig(companyId: string) {
    const [config, company, connectionStatus] = await Promise.all([
      this.getOrCreateAgentConfig(companyId),
      this.prisma.company.findUnique({
        where: { id: companyId },
        select: {
          metaPhoneNumberId: true,
          metaWabaId: true,
          phoneNumber: true,
          metaAccessToken: true,
        },
      }),
      this.getConnectionStatus(companyId),
    ]);

    return {
      id: config.id,
      companyId: config.companyId,
      botName: config.agentName,
      agentName: config.agentName,
      welcomeMessage: config.welcomeMessage,
      initialMessage: config.welcomeMessage,
      companyDescription: config.companyDescription,
      systemPrompt: config.systemPrompt,
      toneOfVoice: config.tone,
      tone: config.tone,
      instructions: config.instructions,
      isActive: config.isEnabled,
      isEnabled: config.isEnabled,
      isOnline: config.isOnline,
      attendantActive: config.isEnabled,
      internetSearchEnabled: config.internetSearchEnabled,
      audioToTextEnabled: config.speechToTextEnabled,
      speechToTextEnabled: config.speechToTextEnabled,
      imageReadingEnabled: config.imageUnderstandingEnabled,
      imageUnderstandingEnabled: config.imageUnderstandingEnabled,
      splitResponsesEnabled: config.splitRepliesEnabled,
      splitRepliesEnabled: config.splitRepliesEnabled,
      bufferEnabled: config.messageBufferEnabled,
      messageBufferEnabled: config.messageBufferEnabled,
      humanPauseEnabled: config.pauseForHuman,
      pauseForHuman: config.pauseForHuman,
      debounceSeconds: config.debounceSeconds,
      contextWindow: config.maxContextMessages,
      maxContextMessages: config.maxContextMessages,
      model: config.modelName,
      modelName: config.modelName,
      modelProvider: config.modelProvider,
      metaPhoneNumberId: company?.metaPhoneNumberId ?? null,
      metaWabaId: company?.metaWabaId ?? null,
      phoneNumber: company?.phoneNumber ?? null,
      isConnected: connectionStatus.connected,
      connectionMethod: connectionStatus.method,
      createdAt: config.createdAt,
      updatedAt: config.updatedAt,
    };
  }

  async updateBotConfig(
    companyId: string,
    data: Partial<{
      botName?: string;
      agentName?: string;
      welcomeMessage?: string;
      toneOfVoice?: string;
      tone?: string;
      instructions?: string;
      systemPrompt?: string;
      companyDescription?: string;
      model?: string;
      modelName?: string;
      internetSearchEnabled?: boolean;
      audioToTextEnabled?: boolean;
      speechToTextEnabled?: boolean;
      imageReadingEnabled?: boolean;
      imageUnderstandingEnabled?: boolean;
      splitResponsesEnabled?: boolean;
      splitRepliesEnabled?: boolean;
      bufferEnabled?: boolean;
      messageBufferEnabled?: boolean;
      humanPauseEnabled?: boolean;
      pauseForHuman?: boolean;
      attendantActive?: boolean;
      debounceSeconds?: number;
      contextWindow?: number;
      isActive?: boolean;
      isOnline?: boolean;
    }>,
  ) {
    const config = await this.getOrCreateAgentConfig(companyId);

    await this.prisma.agentConfig.update({
      where: { id: config.id },
      data: {
        agentName: data.agentName?.trim() || data.botName?.trim() || config.agentName,
        tone: data.tone?.trim() || data.toneOfVoice?.trim() || config.tone,
        toneOfVoice: data.toneOfVoice?.trim() || data.tone?.trim() || config.toneOfVoice,
        welcomeMessage: data.welcomeMessage?.trim() || config.welcomeMessage,
        instructions: data.instructions?.trim() || config.instructions,
        systemPrompt: data.systemPrompt?.trim() || config.systemPrompt,
        companyDescription: data.companyDescription?.trim() || config.companyDescription,
        internetSearchEnabled: data.internetSearchEnabled ?? config.internetSearchEnabled,
        speechToTextEnabled:
          data.audioToTextEnabled ?? data.speechToTextEnabled ?? config.speechToTextEnabled,
        imageUnderstandingEnabled:
          data.imageReadingEnabled ??
          data.imageUnderstandingEnabled ??
          config.imageUnderstandingEnabled,
        splitRepliesEnabled:
          data.splitResponsesEnabled ?? data.splitRepliesEnabled ?? config.splitRepliesEnabled,
        messageBufferEnabled:
          data.bufferEnabled ?? data.messageBufferEnabled ?? config.messageBufferEnabled,
        pauseForHuman: data.humanPauseEnabled ?? data.pauseForHuman ?? config.pauseForHuman,
        debounceSeconds: data.debounceSeconds ?? config.debounceSeconds,
        maxContextMessages: data.contextWindow ?? config.maxContextMessages,
        modelName: data.modelName?.trim() || data.model?.trim() || config.modelName,
        isEnabled: data.attendantActive ?? data.isActive ?? config.isEnabled,
        isOnline: data.isOnline ?? data.isActive ?? config.isOnline,
      },
    });

    return this.getBotConfig(companyId);
  }

  async listLeads(companyId: string, limit = 20) {
    const conversations = await this.prisma.conversation.findMany({
      where: { companyId },
      orderBy: { updatedAt: 'desc' },
      take: limit,
      include: {
        messages: {
          orderBy: { timestamp: 'desc' },
          take: 1,
        },
      },
    });

    return conversations.map((conversation) => ({
      id: conversation.id,
      companyId: conversation.companyId,
      externalId: conversation.contactNumber,
      name: conversation.contactName,
      status: this.mapConversationStatus(conversation.status),
      score: conversation.status === 'IA respondeu' ? 85 : conversation.isPaused ? 40 : 60,
      lastInteraction: conversation.lastMessageAt,
      botPausedUntil: conversation.pausedUntil,
      lastQuotedValue: null,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
      conversations: conversation.messages.map((message) => ({
        id: message.id,
        leadId: conversation.id,
        role: this.mapMessageRole(message.role),
        content: message.content,
        createdAt: message.timestamp,
      })),
    }));
  }

  async listConversationFeed(companyId: string, limit = 20) {
    return this.prisma.conversation.findMany({
      where: { companyId },
      orderBy: { updatedAt: 'desc' },
      take: limit,
      include: {
        messages: {
          orderBy: { timestamp: 'asc' },
          take: HISTORY_LIMIT,
        },
      },
    });
  }

  async getConversationThread(companyId: string, conversationId: string) {
    const conversation = await this.prisma.conversation.findFirst({
      where: { id: conversationId, companyId },
      include: {
        messages: {
          orderBy: { timestamp: 'asc' },
        },
      },
    });

    if (!conversation) {
      throw new BadRequestException('Conversa nao encontrada');
    }

    return conversation;
  }

  async interveneLead(leadId: string, companyId: string) {
    return this.pauseConversation(leadId, companyId);
  }

  async pauseConversation(conversationId: string, companyId: string) {
    const conversation = await this.ensureConversation(conversationId, companyId);
    const pausedUntil = this.addHours(new Date(), HUMAN_PAUSE_HOURS);

    const updated = await this.prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        isPaused: true,
        pausedUntil,
        status: 'Humano assumiu',
      },
    });

    await this.emitConversationUpdate(companyId, updated.id, {
      event: 'conversation.paused',
    });
    return updated;
  }

  async resumeConversation(conversationId: string, companyId: string) {
    const conversation = await this.ensureConversation(conversationId, companyId);

    const updated = await this.prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        isPaused: false,
        pausedUntil: null,
        status: 'Aguardando',
      },
    });

    await this.emitConversationUpdate(companyId, updated.id, {
      event: 'conversation.resumed',
    });
    return updated;
  }

  async sendHumanMessage(
    companyId: string,
    conversationId: string,
    content: string,
  ) {
    const conversation = await this.ensureConversation(conversationId, companyId);
    const trimmedContent = content.trim();

    if (!trimmedContent) {
      throw new BadRequestException('Mensagem vazia');
    }

    await this.dispatchOutboundMessage(
      companyId,
      conversation.contactNumber,
      trimmedContent,
      IntegrationProvider.WHATSAPP,
    );

    await this.prisma.message.create({
      data: {
        companyId,
        conversationId: conversation.id,
        content: trimmedContent,
        role: 'human',
        direction: 'outbound',
        contentType: 'text',
        status: 'sent',
      },
    });

    const updated = await this.prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        isPaused: true,
        pausedUntil: this.addHours(new Date(), HUMAN_PAUSE_HOURS),
        status: 'Humano assumiu',
        lastMessageAt: new Date(),
      },
      include: {
        messages: {
          orderBy: { timestamp: 'asc' },
        },
      },
    });

    await this.emitConversationUpdate(companyId, updated.id, {
      event: 'human.message.sent',
    });
    return updated;
  }

  async getRoi(companyId: string) {
    const [attributionTotal, iaReplies, bySource] = await Promise.all([
      this.prisma.saleAIAttribution.aggregate({
        where: {
          companyId,
        },
        _sum: {
          attributedRevenue: true,
        },
        _count: {
          id: true,
        },
      }),
      this.prisma.message.count({
        where: {
          conversation: { companyId },
          role: 'assistant',
        },
      }),
      this.prisma.saleAIAttribution.groupBy({
        by: ['source'],
        where: { companyId },
        _sum: { attributedRevenue: true },
        _count: { id: true },
      }),
    ]);
    const iaRevenue = Number(attributionTotal._sum.attributedRevenue || 0);

    return {
      iaSalesCount: attributionTotal._count.id,
      iaRevenue: Math.round((iaRevenue + Number.EPSILON) * 100) / 100,
      iaReplies,
      bySource: bySource.map((item) => ({
        source: item.source,
        salesCount: item._count.id,
        revenue: Math.round((Number(item._sum.attributedRevenue || 0) + Number.EPSILON) * 100) / 100,
      })),
    };
  }

  async getConnectionStatus(companyId: string) {
    const [company, evolutionSnapshot, metaHealth] = await Promise.all([
      this.prisma.company.findUnique({
        where: { id: companyId },
        select: {
          metaPhoneNumberId: true,
          metaAccessToken: true,
          phoneNumber: true,
        },
      }),
      this.evolutionService.getConnectionSnapshot(companyId),
      this.metaIntegrationService.getHealthStatus(companyId),
    ]);

    const connectedViaMeta = metaHealth.connected;
    const connectedViaEvolution =
      !connectedViaMeta && Boolean(evolutionSnapshot.connected);
    const awaitingQr =
      !connectedViaMeta &&
      !connectedViaEvolution &&
      Boolean(evolutionSnapshot.qrRequired);

    return {
      connected: connectedViaMeta || connectedViaEvolution,
      method: connectedViaMeta
        ? 'meta'
        : connectedViaEvolution
          ? 'evolution'
          : null,
      status: connectedViaMeta || connectedViaEvolution
        ? 'connected'
        : awaitingQr
          ? 'qr_ready'
          : evolutionSnapshot.status,
      phoneNumberId: company?.metaPhoneNumberId ?? null,
      phoneNumber: connectedViaMeta ? metaHealth.phoneNumber : company?.phoneNumber ?? null,
      qrCode: connectedViaMeta ? null : evolutionSnapshot.qrCode,
      qrRequired: awaitingQr,
      sessionId: evolutionSnapshot.instanceName,
      updatedAt: connectedViaMeta
        ? metaHealth.dbLastConnected
        : evolutionSnapshot.updatedAt,
    };
  }

  private async processWhatsappMessageEvent(
    messageEventId: string,
    companyId: string,
  ) {
    const event = await this.prisma.whatsappMessageEvent.findFirst({
      where: { id: messageEventId, companyId },
    });

    if (!event) {
      return;
    }

    if (
      event.status === WhatsappMessageProcessStatus.PROCESSED ||
      event.status === WhatsappMessageProcessStatus.IGNORED
    ) {
      return;
    }

    const claimed = await this.prisma.whatsappMessageEvent.updateMany({
      where: {
        id: event.id,
        status: {
          in: [
            WhatsappMessageProcessStatus.PENDING,
            WhatsappMessageProcessStatus.FAILED,
          ],
        },
      },
      data: {
        status: WhatsappMessageProcessStatus.PROCESSING,
        errorMessage: null,
      },
    });

    if (!claimed.count) {
      return;
    }

    try {
      await this.processIncomingMessage(
        companyId,
        IntegrationProvider.WHATSAPP,
        event.remoteNumber,
        event.text || '',
        event.pushName,
      );

      await this.prisma.whatsappMessageEvent.update({
        where: { id: event.id },
        data: {
          status: WhatsappMessageProcessStatus.PROCESSED,
          processedAt: new Date(),
          errorMessage: null,
        },
      });
    } catch (error) {
      await this.prisma.whatsappMessageEvent.update({
        where: { id: event.id },
        data: {
          status: WhatsappMessageProcessStatus.FAILED,
          errorMessage: (error as Error)?.message || 'Falha ao processar mensagem',
        },
      }).catch(() => undefined);

      throw error;
    }
  }

  private async processIncomingMessage(
    companyId: string,
    provider: IntegrationProvider,
    externalId: string,
    text: string,
    name?: string | null,
  ) {
    const config = await this.getOrCreateAgentConfig(companyId);
    this.logger.log(
      `[BOT][${companyId}] Mensagem recebida de ${externalId}: ${this.buildLogPreview(text)}`,
    );

    let conversation = await this.prisma.conversation.upsert({
      where: {
        companyId_contactNumber: {
          companyId,
          contactNumber: externalId,
        },
      },
      update: {
        contactName: name || undefined,
        lastMessageAt: new Date(),
        status: 'Aguardando',
      },
      create: {
        companyId,
        contactNumber: externalId,
        contactName: name || undefined,
        status: 'Aguardando',
        lastMessageAt: new Date(),
      },
    });

    await this.prisma.message.create({
      data: {
        companyId,
        conversationId: conversation.id,
        content: text,
        role: 'user',
        direction: 'inbound',
        contentType: 'text',
        status: 'received',
      },
    });
    await this.emitConversationUpdate(companyId, conversation.id, {
      event: 'message.received',
      incomingMessage: text,
    });

    const now = new Date();
    const paused =
      conversation.isPaused &&
      (!conversation.pausedUntil || conversation.pausedUntil > now);

    if (paused) {
      this.logger.warn(`[BOT][${companyId}] Bot pausado para ${externalId}.`);
      await this.prisma.conversation.update({
        where: { id: conversation.id },
        data: {
          status: 'Humano assumiu',
          lastMessageAt: new Date(),
        },
      });
      await this.emitConversationUpdate(companyId, conversation.id, {
        event: 'conversation.paused',
        incomingMessage: text,
      });
      return;
    }

    if (conversation.isPaused && conversation.pausedUntil && conversation.pausedUntil <= now) {
      conversation = await this.prisma.conversation.update({
        where: { id: conversation.id },
        data: {
          isPaused: false,
          pausedUntil: null,
          status: 'Aguardando',
          lastMessageAt: now,
        },
      });
      this.logger.log(`[BOT][${companyId}] Pausa expirada para ${externalId}.`);
    }

    if (!config.isOnline) {
      this.logger.warn(`[BOT][${companyId}] Bot offline para ${externalId}.`);
      await this.prisma.conversation.update({
        where: { id: conversation.id },
        data: {
          status: 'Aguardando',
          lastMessageAt: new Date(),
        },
      });
      await this.emitConversationUpdate(companyId, conversation.id, {
        event: 'agent.offline',
        incomingMessage: text,
      });
      return;
    }

    if (this.hasHumanEscalationSignal(text)) {
      const transferMessage = 'Um momento. Vou chamar um atendente humano.';
      this.logger.warn(`[BOT][${companyId}] Cliente ${externalId} pediu humano.`);
      await this.pauseConversation(conversation.id, companyId);
      await this.alertsService.createAlert({
        companyId,
        type: 'BOT_HANDOFF',
        severity: 'critical',
        message: `Cliente ${name || externalId} pediu atendimento humano.`,
      });
      try {
        await this.dispatchOutboundMessage(companyId, externalId, transferMessage, provider);
        await this.prisma.message.create({
          data: {
            companyId,
            conversationId: conversation.id,
            content: transferMessage,
            role: 'assistant',
            direction: 'outbound',
            contentType: 'text',
            status: 'sent',
          },
        });
      } catch (error) {
        this.logger.error(
          `Falha ao enviar mensagem de transferencia: ${(error as Error)?.message || 'erro desconhecido'}`,
        );
      }
      return;
    }

    const history = await this.prisma.message.findMany({
      where: { conversationId: conversation.id },
      orderBy: { timestamp: 'desc' },
      take: HISTORY_LIMIT,
    });

    const productContext = await this.buildContext(companyId, text);
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { name: true },
    });

    const prompt = this.buildPrompt({
      agentName: config.agentName,
      tone: config.tone,
      instructions: config.instructions,
      welcomeMessage: config.welcomeMessage,
      companyName: company?.name || 'sua empresa',
      customerMessage: text,
      productContext,
      history: history.reverse().map((message) => ({
        role: message.role,
        content: message.content,
      })),
    });

    let reply = config.welcomeMessage;
    this.logger.log(
      `[BOT][${companyId}] Gerando resposta para ${externalId} com ${history.length} mensagens.`,
    );

    try {
      const rag = await this.ragService.buildContext(companyId, text);
      const result = await this.aiService.generateText(
        `${rag}\n\n${prompt}`,
        companyId,
        'simple',
        {
          feature: AIUsageFeature.WHATSAPP_AGENT,
          metadata: {
            source: 'attendant_service',
            conversationId: conversation.id,
            provider,
          },
        },
      );
      reply = result.text.trim() || reply;
    } catch (error) {
      this.logger.warn(
        `Falha ao gerar resposta da IA: ${(error as Error)?.message || 'erro desconhecido'}`,
      );
    }

    if (reply.toUpperCase().includes('PAUSAR_BOT')) {
      const transferMessage = 'Um momento. Vou chamar um atendente humano.';
      this.logger.warn(`[BOT][${companyId}] IA pediu atendimento humano para ${externalId}.`);

      await this.pauseConversation(conversation.id, companyId);
      await this.alertsService.createAlert({
        companyId,
        type: 'BOT_HANDOFF',
        severity: 'critical',
        message: `Cliente ${name || externalId} precisa de atendimento humano.`,
      }).catch(() => null);

      try {
        await this.dispatchOutboundMessage(companyId, externalId, transferMessage, provider);
      } catch (error) {
        this.logger.error(
          `Falha ao enviar mensagem de transferencia: ${(error as Error)?.message || 'erro desconhecido'}`,
        );
        return;
      }

      await this.prisma.message.create({
        data: {
          companyId,
          conversationId: conversation.id,
          content: transferMessage,
          role: 'assistant',
          direction: 'outbound',
          contentType: 'text',
          status: 'sent',
        },
      });
      await this.emitConversationUpdate(companyId, conversation.id, {
        event: 'ai.handoff',
        incomingMessage: text,
        aiResponse: transferMessage,
        badge: 'Humano acionado',
      });
      return;
    }

    try {
      await this.dispatchOutboundMessage(companyId, externalId, reply, provider);
    } catch (error) {
      this.logger.error(
        `Falha ao enviar mensagem automatica: ${(error as Error)?.message || 'erro desconhecido'}`,
      );
      await this.prisma.conversation.update({
        where: { id: conversation.id },
        data: { status: 'Aguardando', lastMessageAt: new Date() },
      });
      return;
    }

    await this.prisma.message.create({
      data: {
        companyId,
        conversationId: conversation.id,
        content: reply,
        role: 'assistant',
        direction: 'outbound',
        contentType: 'text',
        status: 'sent',
      },
    });

    await this.prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        status: 'IA respondeu',
        lastMessageAt: new Date(),
      },
    });
    await this.emitConversationUpdate(companyId, conversation.id, {
      event: 'ai.replied',
      incomingMessage: text,
      aiResponse: reply,
      badge: 'IA respondeu',
    });
    this.logger.log(`[BOT][${companyId}] Resposta enviada para ${externalId}.`);
  }

  private async dispatchOutboundMessage(
    companyId: string,
    contactNumber: string,
    content: string,
    provider: IntegrationProvider,
  ) {
    if (provider === IntegrationProvider.INSTAGRAM) {
      return this.instagramService.sendDm(companyId, contactNumber, content);
    }

    const connectionStatus = await this.getConnectionStatus(companyId);
    if (connectionStatus.method === 'evolution') {
      return this.evolutionService.sendTextMessage(companyId, contactNumber, content);
    }

    return this.metaIntegrationService.sendTextMessage(companyId, contactNumber, content);
  }

  private buildPrompt(input: {
    agentName: string;
    tone: string;
    instructions: string;
    welcomeMessage: string;
    companyName: string;
    customerMessage: string;
    productContext: string;
    history: Array<{ role: string; content: string }>;
  }) {
    const historyText = input.history.length
      ? input.history
          .map((item) => `${item.role}: ${item.content}`)
          .join('\n')
      : 'Sem historico anterior.';

    return [
      `Voce e ${input.agentName}, assistente virtual da empresa ${input.companyName}.`,
      `Tom de voz: ${input.tone}.`,
      'Fale sempre em portugues do Brasil.',
      'Sempre diga que voce e uma assistente virtual.',
      'Nunca invente preco. Se faltar valor, diga que vai confirmar com um humano.',
      'Se o cliente pedir atendimento humano, responda somente com PAUSAR_BOT.',
      'Se o cliente demonstrar frustracao, oriente que o atendimento sera transferido.',
      `Mensagem de boas-vindas: ${input.welcomeMessage}`,
      `Instrucoes da empresa: ${input.instructions}`,
      `Contexto: ${input.productContext}`,
      `Historico recente:\n${historyText}`,
      `Mensagem atual: ${input.customerMessage}`,
      'Responda de forma curta, clara e com proximo passo.',
    ].join('\n\n');
  }

  private async buildContext(companyId: string, query: string) {
    const products = await this.prisma.product.findMany({
      where: {
        companyId,
        OR: [
          { name: { contains: query, mode: 'insensitive' } },
          { category: { contains: query, mode: 'insensitive' } },
        ],
      },
      take: 5,
    });

    if (!products.length) {
      return 'Sem produto especifico encontrado. Se faltar informacao, diga que vai confirmar.';
    }

    return products
      .map(
        (product) =>
          `${product.name} | categoria: ${product.category || 'geral'} | preco: R$ ${Number(
            product.price,
          ).toFixed(2)}`,
      )
      .join('\n');
  }

  private async ensureConversation(conversationId: string, companyId: string) {
    const conversation = await this.prisma.conversation.findFirst({
      where: { id: conversationId, companyId },
    });

    if (!conversation) {
      throw new BadRequestException('Conversa nao encontrada');
    }

    return conversation;
  }

  private async getOrCreateAgentConfig(companyId: string) {
    const existing = await this.prisma.agentConfig.findUnique({
      where: { companyId },
    });

    if (existing) return existing;

    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { name: true },
    });

    return this.prisma.agentConfig.create({
      data: {
        companyId,
        agentName: 'Atendente Next Level',
        tone: 'Amigável',
        welcomeMessage: `Olá! Sou a assistente virtual da ${company?.name || 'empresa'}. Como posso te ajudar hoje?`,
        instructions:
          'Seja educada, prestativa e objetiva. Nunca invente precos. Se o cliente pedir humano, avise que vai transferir.',
        isOnline: true,
      },
    });
  }

  private hasHumanEscalationSignal(text: string) {
    const normalized = text.toLowerCase();
    return [
      'humano',
      'atendente',
      'reclam',
      'procon',
      'cancel',
      'insatisfeito',
      'nao resolveu',
    ].some((term) => normalized.includes(term));
  }

  private mapConversationStatus(status: string) {
    if (status === 'IA respondeu') return 'QUALIFIED';
    if (status === 'Humano assumiu') return 'LOST';
    return 'NEW';
  }

  private mapMessageRole(role: string) {
    if (role === 'assistant') return 'ASSISTANT';
    return 'USER';
  }

  private extractWhatsappMessages(payload: Record<string, unknown>) {
    const messages: Array<{ from: string; text: string; name?: string | null }> = [];
    const entries = (payload.entry as Array<Record<string, unknown>>) || [];

    for (const entry of entries) {
      const changes = (entry.changes as Array<Record<string, unknown>>) || [];
      for (const change of changes) {
        const value = (change.value as Record<string, unknown>) || {};
        const contacts = (value.contacts as Array<Record<string, unknown>>) || [];
        const profile = contacts[0]?.profile as Record<string, unknown> | undefined;
        const msgs = (value.messages as Array<Record<string, unknown>>) || [];

        for (const msg of msgs) {
          const from = String(msg.from || '');
          const text =
            (msg.text as { body?: string } | undefined)?.body ||
            (msg.button as { text?: string } | undefined)?.text ||
            '';

          if (from && text) {
            messages.push({
              from,
              text,
              name: typeof profile?.name === 'string' ? profile.name : undefined,
            });
          }
        }
      }
    }

    return messages;
  }

  private extractInstagramMessages(payload: Record<string, unknown>) {
    const messages: Array<{ from: string; text: string; name?: string | null }> = [];
    const entries = (payload.entry as Array<Record<string, unknown>>) || [];

    for (const entry of entries) {
      const messaging = (entry.messaging as Array<Record<string, unknown>>) || [];
      for (const item of messaging) {
        const from = typeof item.sender === 'object' ? String((item.sender as { id?: string }).id || '') : '';
        const message = item.message as Record<string, unknown> | undefined;
        const text = typeof message?.text === 'string' ? message.text : '';

        if (from && text && !message?.is_echo) {
          messages.push({ from, text, name: null });
        }
      }
    }

    return messages;
  }

  private addHours(date: Date, hours: number) {
    const next = new Date(date);
    next.setHours(next.getHours() + hours);
    return next;
  }

  private async emitConversationUpdate(
    companyId: string,
    conversationId: string,
    extras?: Record<string, unknown>,
  ) {
    const conversation = await this.prisma.conversation.findFirst({
      where: { id: conversationId, companyId },
      include: {
        messages: {
          orderBy: { timestamp: 'asc' },
          take: HISTORY_LIMIT,
        },
      },
    });

    if (!conversation) {
      return;
    }

    this.attendantGateway.emitConversationEvent(companyId, {
      companyId,
      conversation,
      timestamp: new Date().toISOString(),
      ...extras,
    });
  }

  private buildLogPreview(value: string) {
    const normalized = value.replace(/\s+/g, ' ').trim();
    if (normalized.length <= 80) {
      return normalized;
    }

    return `${normalized.slice(0, 77)}...`;
  }
}
