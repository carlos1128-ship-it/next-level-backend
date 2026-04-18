import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { IntegrationProvider, Prisma } from '@prisma/client';
import { AiService } from '../ai/ai.service';
import { RagService } from '../ai/rag.service';
import { PrismaService } from '../../prisma/prisma.service';
import { MetaIntegrationService } from '../meta/meta.service';
import { InstagramService } from '../integrations/instagram.service';
import { AlertsService } from '../alerts/alerts.service';

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
    private readonly alertsService: AlertsService,
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

  async getBotConfig(companyId: string) {
    const [config, company] = await Promise.all([
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
      isConnected: Boolean(company?.metaPhoneNumberId && company?.metaAccessToken),
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

    return this.prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        isPaused: true,
        pausedUntil,
        status: 'Humano assumiu',
      },
    });
  }

  async resumeConversation(conversationId: string, companyId: string) {
    const conversation = await this.ensureConversation(conversationId, companyId);

    return this.prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        isPaused: false,
        pausedUntil: null,
        status: 'Aguardando',
      },
    });
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

    return this.prisma.conversation.update({
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
    return {
      status: 'AWAITING_QR_SCAN',
      message: 'Fluxo rapido habilitado para QR Code.',
      qrCode: `wppconnect:${companyId}`,
    };
  }

  async getWhatsappQrCode(companyId: string) {
    const health = await this.metaIntegrationService.getHealthStatus(companyId);
    return {
      qrCode: health.connected ? null : `wppconnect:${companyId}`,
      status: health.connected ? 'CONNECTED' : 'AWAITING_QR_SCAN',
    };
  }

  async terminateWhatsappSession(companyId: string) {
    return { success: true, message: `Sessao encerrada para ${companyId}` };
  }

  async getWhatsappStatus(companyId: string) {
    const health = await this.metaIntegrationService.getHealthStatus(companyId);
    return {
      status: health.status,
      qrCode: health.connected ? null : `wppconnect:${companyId}`,
      quotaUsed: 0,
      quotaLimit: 10000,
    };
  }

  async getWhatsappHealth(companyId: string) {
    return this.metaIntegrationService.getHealthStatus(companyId);
  }

  async cleanupWhatsappSession(companyId: string) {
    return { success: true, companyId, status: 'clean' };
  }

  private async processIncomingMessage(
    companyId: string,
    provider: IntegrationProvider,
    externalId: string,
    text: string,
    name?: string | null,
  ) {
    const config = await this.getOrCreateAgentConfig(companyId);
    const conversation = await this.prisma.conversation.upsert({
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

    const paused =
      conversation.isPaused &&
      conversation.pausedUntil &&
      conversation.pausedUntil > new Date();

    if (paused || !config.isOnline) {
      await this.prisma.conversation.update({
        where: { id: conversation.id },
        data: {
          status: paused ? 'Humano assumiu' : 'Aguardando',
          lastMessageAt: new Date(),
        },
      });
      return;
    }

    if (this.hasHumanEscalationSignal(text)) {
      await this.pauseConversation(conversation.id, companyId);
      await this.alertsService.createAlert({
        companyId,
        type: 'BOT_HANDOFF',
        severity: 'critical',
        message: `Cliente ${name || externalId} pediu atendimento humano.`,
      });
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
}
