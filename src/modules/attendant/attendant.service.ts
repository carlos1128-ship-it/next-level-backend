import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { IntegrationProvider, Prisma } from '@prisma/client';
import { AiService } from '../ai/ai.service';
import { RagService } from '../ai/rag.service';
import { PrismaService } from '../../prisma/prisma.service';
import { MetaIntegrationService } from '../meta/meta.service';
import { InstagramService } from '../integrations/instagram.service';
import { WppconnectService } from '../integrations/wppconnect.service';
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
    private readonly wppconnectService: WppconnectService,
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

  @OnEvent('whatsapp.status.updated')
  handleWhatsappStatusUpdate(payload: { companyId: string; status: string }) {
    this.attendantGateway.emitWhatsappStatus(payload.companyId, payload.status);
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
      toneOfVoice: config.tone,
      tone: config.tone,
      instructions: config.instructions,
      isActive: config.isOnline,
      isOnline: config.isOnline,
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
        welcomeMessage: data.welcomeMessage?.trim() || config.welcomeMessage,
        instructions: data.instructions?.trim() || config.instructions,
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
        conversationId: conversation.id,
        content: trimmedContent,
        role: 'human',
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
    const [totalConversations, iaReplies] = await Promise.all([
      this.prisma.conversation.count({ where: { companyId } }),
      this.prisma.message.count({
        where: {
          conversation: { companyId },
          role: 'assistant',
        },
      }),
    ]);

    return {
      iaSalesCount: iaReplies,
      iaRevenue: totalConversations * 0,
    };
  }

  async createWhatsappSession(companyId: string) {
    const result = await this.wppconnectService.createSession(companyId, { fresh: true });
    return {
      ...result,
      message: 'Fluxo rapido habilitado para QR Code com sessao nova.',
    };
  }

  async getWhatsappQrCode(companyId: string) {
    const [health, qrcode] = await Promise.all([
      this.wppconnectService.getHealthStatus(companyId),
      Promise.resolve(this.wppconnectService.getQrCode(companyId)),
    ]);
    const qrCode = qrcode || health.qrCode;

    return {
      qrcode: qrCode,
      qrCode,
      ready: Boolean(qrCode),
      status: qrCode ? 'ready' : 'generating',
      connectionStatus: health.status,
      connected: health.connected,
      method: health.connected ? 'wppconnect' : null,
    };
  }

  async terminateWhatsappSession(companyId: string) {
    return this.wppconnectService.terminateSession(companyId);
  }

  async getWhatsappStatus(companyId: string) {
    const wppHealth = await this.wppconnectService.getHealthStatus(companyId);
    return {
      status: wppHealth.connected
        ? 'CONNECTED'
        : wppHealth.awaitingQR
          ? 'AWAITING_QR_SCAN'
          : wppHealth.qrRequired
            ? 'QR_REQUIRED'
          : wppHealth.status,
      qrcode: wppHealth.qrCode,
      qrCode: wppHealth.qrCode,
      connected: wppHealth.connected,
      method: wppHealth.connected ? 'wppconnect' : null,
      phoneNumber: wppHealth.phoneNumber,
      qrRequired: wppHealth.qrRequired,
      updatedAt: wppHealth.dbLastConnected,
      quotaUsed: 0,
      quotaLimit: 10000,
    };
  }

  async getWhatsappHealth(companyId: string) {
    const wppHealth = await this.wppconnectService.getHealthStatus(companyId);
    return {
      ...wppHealth,
      method: wppHealth.connected ? 'wppconnect' : null,
    };
  }

  async cleanupWhatsappSession(companyId: string) {
    return this.wppconnectService.forceCleanupSession(companyId);
  }

  async getConnectionStatus(companyId: string) {
    const [company, wppHealth, metaHealth] = await Promise.all([
      this.prisma.company.findUnique({
        where: { id: companyId },
        select: {
          metaPhoneNumberId: true,
          metaAccessToken: true,
          phoneNumber: true,
        },
      }),
      this.wppconnectService.getHealthStatus(companyId),
      this.metaIntegrationService.getHealthStatus(companyId),
    ]);

    const connectedViaMeta = metaHealth.connected;
    const connectedViaWpp = !connectedViaMeta && wppHealth.connected;
    const awaitingQr = !connectedViaMeta && wppHealth.awaitingQR;

    return {
      connected: connectedViaMeta || connectedViaWpp,
      method: connectedViaMeta
        ? 'meta'
        : connectedViaWpp
          ? 'wppconnect'
          : null,
      status: connectedViaMeta || connectedViaWpp
        ? 'CONNECTED'
        : awaitingQr
          ? 'AWAITING_QR_SCAN'
          : wppHealth.qrRequired
            ? 'QR_REQUIRED'
          : 'DISCONNECTED',
      phoneNumberId: company?.metaPhoneNumberId ?? null,
      phoneNumber: connectedViaMeta ? metaHealth.phoneNumber : wppHealth.phoneNumber,
      qrCode: connectedViaMeta ? null : wppHealth.qrCode,
      qrRequired: wppHealth.qrRequired,
      sessionId: null,
      updatedAt: connectedViaMeta ? metaHealth.dbLastConnected : wppHealth.dbLastConnected,
    };
  }

  private async processIncomingMessage(
    companyId: string,
    provider: IntegrationProvider,
    externalId: string,
    text: string,
    name?: string | null,
  ) {
    const config = await this.getOrCreateAgentConfig(companyId);
    this.logger.log(`[BOT][${companyId}] Mensagem recebida de ${externalId}: ${text}`);

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
        conversationId: conversation.id,
        content: text,
        role: 'user',
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
            conversationId: conversation.id,
            content: transferMessage,
            role: 'assistant',
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
          conversationId: conversation.id,
          content: transferMessage,
          role: 'assistant',
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
        conversationId: conversation.id,
        content: reply,
        role: 'assistant',
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
    if (connectionStatus.method === 'wppconnect') {
      return this.wppconnectService.sendTextMessage(companyId, contactNumber, content);
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
}
