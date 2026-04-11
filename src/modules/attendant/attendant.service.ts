import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  AiChatRole,
  IntegrationProvider,
  LeadStatus,
  Prisma,
} from '@prisma/client';
import { AiService } from '../ai/ai.service';
import { RagService } from '../ai/rag.service';
import { PrismaService } from '../../prisma/prisma.service';
import { WhatsappService } from '../whatsapp/whatsapp.service';
import { InstagramService } from '../integrations/instagram.service';
import { AlertsService } from '../alerts/alerts.service';

const HOT_SCORE_THRESHOLD = 80;
const QUALIFIED_THRESHOLD = 50;
const HISTORY_LIMIT = 10;

@Injectable()
export class AttendantService {
  private readonly logger = new Logger(AttendantService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly aiService: AiService,
    private readonly ragService: RagService,
    private readonly whatsappService: WhatsappService,
    private readonly instagramService: InstagramService,
    private readonly alertsService: AlertsService,
  ) {}

  private async resolveCompanyIdForUser(userId: string, companyId?: string | null) {
    const normalizedCompanyId = companyId?.trim();

    if (normalizedCompanyId) {
      const company = await this.prisma.company.findFirst({
        where: {
          id: normalizedCompanyId,
          OR: [{ userId }, { users: { some: { id: userId } } }],
        },
        select: { id: true },
      });

      if (!company) {
        throw new BadRequestException('Empresa invalida');
      }

      return company.id;
    }

    const owned = await this.prisma.company.findFirst({
      where: {
        OR: [{ userId }, { users: { some: { id: userId } } }],
      },
      select: { id: true },
    });

    if (!owned?.id) {
      throw new BadRequestException('companyId nao informado');
    }

    return owned.id;
  }

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

    let messages: Array<{ from: string; text: string; name?: string | null }>;
    if (payload.provider === IntegrationProvider.INSTAGRAM) {
      messages = this.extractInstagramMessages(rawPayload);
    } else {
      messages = this.extractWhatsappMessages(rawPayload);
    }

    for (const msg of messages) {
      await this.processIncomingMessage(companyId, payload.provider, msg.from, msg.text, msg.name);
    }

    await this.prisma.webhookEvent.update({
      where: { id: event.id },
      data: { processed: true },
    });
  }

  async getBotConfig(companyId: string) {
    return this.getOrCreateConfig(companyId);
  }

  async updateBotConfig(companyId: string, data: Partial<{
    botName?: string;
    welcomeMessage?: string;
    toneOfVoice?: string;
    instructions?: string;
    isActive?: boolean;
  }>) {
    const config = await this.getOrCreateConfig(companyId);
    return this.prisma.botConfig.update({
      where: { id: config.id },
      data: {
        botName: data.botName?.trim() || config.botName,
        welcomeMessage: data.welcomeMessage ?? config.welcomeMessage,
        toneOfVoice: data.toneOfVoice?.trim() || config.toneOfVoice,
        instructions: data.instructions ?? config.instructions,
        isActive: data.isActive ?? config.isActive,
      },
    });
  }

  async listLeads(companyId: string, limit = 20) {
    return this.prisma.lead.findMany({
      where: { companyId },
      orderBy: { updatedAt: 'desc' },
      take: limit,
      include: {
        conversations: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
    });
  }

  async interveneLead(leadId: string, companyId: string) {
    const lead = await this.prisma.lead.findFirst({
      where: { id: leadId, companyId },
    });
    if (!lead) throw new BadRequestException('Lead nao encontrado');

    const pauseUntil = this.addHours(new Date(), 24);
    return this.prisma.lead.update({
      where: { id: lead.id },
      data: { botPausedUntil: pauseUntil },
    });
  }

  async getRoi(companyId: string) {
    const converted = await this.prisma.lead.findMany({
      where: { companyId, status: LeadStatus.CONVERTED },
      select: { lastQuotedValue: true },
    });
    const iaSalesCount = converted.length;
    const iaRevenue = converted.reduce(
      (sum, l) => sum + Number(l.lastQuotedValue ?? 0),
      0,
    );
    return {
      iaSalesCount,
      iaRevenue: Number(iaRevenue.toFixed(2)),
    };
  }

  // ─── Core Message Processing ───────────────────────────────────────────────

  async createWhatsappSession(companyId: string) {
    return this.whatsappService.createSession(companyId);
  }

  async getWhatsappQrCode(companyId: string) {
    const base64 = this.whatsappService.getQrCode(companyId);
    return {
      qrCode: base64 ?? null,
      status: this.whatsappService.getStatus(companyId),
    };
  }

  async terminateWhatsappSession(companyId: string) {
    return this.whatsappService.terminateSession(companyId);
  }

  async getWhatsappStatus(companyId: string) {
    const status = this.whatsappService.getStatus(companyId);
    const qrCode = this.whatsappService.getQrCode(companyId);
    return {
      status,
      qrCode,
      quotaUsed: 0,
      quotaLimit: 10000,
    };
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

  private async processIncomingMessage(
    companyId: string,
    provider: IntegrationProvider,
    externalId: string,
    text: string,
    name?: string | null,
  ) {
    const botConfig = await this.getOrCreateConfig(companyId);
    if (!botConfig.isActive) return;

    // Verificação de quota (tier freemium)
    if (botConfig.messageQuotaUsed >= botConfig.messageQuotaLimit) {
      this.logger.warn(`Quota de mensagens esgotada para empresa ${companyId} (${botConfig.messageQuotaUsed}/${botConfig.messageQuotaLimit})`);
      return;
    }

    let lead = await this.prisma.lead.upsert({
      where: { companyId_externalId: { companyId, externalId } },
      update: {
        name: name || undefined,
        lastInteraction: new Date(),
      },
      create: {
        companyId,
        externalId,
        name: name || undefined,
        status: LeadStatus.NEW,
        lastInteraction: new Date(),
      },
    });

    if (lead.botPausedUntil && lead.botPausedUntil > new Date()) {
      this.logger.warn(`Bot pausado para lead ${externalId}, ignorando resposta automatica.`);
      return;
    }

    await this.prisma.chatConversation.create({
      data: { leadId: lead.id, role: AiChatRole.USER, content: text },
    });

    const frustrationKeywords = ['reclama', 'reclamação', 'procon', 'humano', 'atendente', 'insatisfeito'];
    if (this.containsKeyword(text, frustrationKeywords)) {
      await this.prisma.lead.update({
        where: { id: lead.id },
        data: { botPausedUntil: this.addHours(new Date(), 24) },
      });
      await this.alertsService.createAlert({
        companyId,
        type: 'BOT_HANDOFF',
        severity: 'critical',
        message: `Escalonamento humano: lead ${lead.name ?? externalId} solicitou atendimento humano.`,
      });
      return;
    }

    const history = await this.prisma.chatConversation.findMany({
      where: { leadId: lead.id },
      orderBy: { createdAt: 'desc' },
      take: HISTORY_LIMIT,
      select: { role: true, content: true },
    });
    const historyAsc = history.reverse();

    const { context, lastQuotedValue } = await this.buildContext(companyId, text);
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { name: true },
    });

    const prompt = this.buildPrompt({
      botName: botConfig.botName,
      companyName: company?.name ?? 'sua empresa',
      tone: botConfig.toneOfVoice,
      instructions: botConfig.instructions,
      productContext: context,
      customerMessage: text,
      welcomeMessage: botConfig.welcomeMessage,
      history: historyAsc,
    });

    let reply = botConfig.welcomeMessage || 'Oi! Sou o assistente virtual da empresa, pronto para ajudar.';
    try {
      const rag = await this.ragService.buildContext(companyId, text);
      const result = await this.aiService['generateText']?.(`${rag}\n\n${prompt}`);
      reply = result?.text?.trim() || reply;
    } catch (error) {
      this.logger.warn(`IA indisponivel, usando fallback simples: ${(error as Error)?.message}`);
    }

    try {
      if (provider === IntegrationProvider.INSTAGRAM) {
        await this.instagramService.sendDm(companyId, externalId, reply);
      } else {
        await this.whatsappService.sendTextMessage(companyId, externalId, reply);
      }
    } catch (sendError) {
      this.logger.error(`Falha ao enviar resposta via ${provider}: ${(sendError as Error)?.message}`);
    }

    await this.prisma.chatConversation.create({
      data: { leadId: lead.id, role: AiChatRole.ASSISTANT, content: reply },
    });

    // Incrementa quota após resposta enviada com sucesso
    await this.prisma.botConfig.update({
      where: { id: botConfig.id },
      data: { messageQuotaUsed: { increment: 1 } },
    });

    lead = await this.scoreLead(companyId, lead, text, lastQuotedValue);
  }

  private buildPrompt(input: {
    botName: string;
    companyName: string;
    tone: string;
    instructions?: string | null;
    productContext: string;
    customerMessage: string;
    welcomeMessage?: string | null;
    history: Array<{ role: AiChatRole; content: string }>;
  }) {
    const historyLines = input.history.length
      ? input.history
          .map((m) => `${m.role === AiChatRole.USER ? 'Cliente' : input.botName}: ${m.content}`)
          .join('\n')
      : null;

    return [
      `Você é ${input.botName}, assistente virtual da empresa ${input.companyName}.`,
      `Tom de voz: ${input.tone}.`,
      'Identifique-se sempre como assistente virtual e seja transparente.',
      'Regras de ouro: nunca invente preços. Se não houver preço no contexto, responda: "Vou confirmar essa informação com um consultor humano".',
      'Se detectar reclamação ou frustração, sugira escalar para um humano.',
      input.instructions ? `Instruções da marca: ${input.instructions}` : '',
      input.welcomeMessage ? `Abertura sugerida: ${input.welcomeMessage}` : '',
      'Contexto de produtos e promoções:',
      input.productContext,
      historyLines ? `Histórico recente da conversa:\n${historyLines}` : '',
      `Mensagem atual do cliente: "${input.customerMessage}"`,
      'Responda em português do Brasil, curto e orientado à conversão (próximo passo claro).',
    ]
      .filter(Boolean)
      .join('\n\n');
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

    const promos = await this.prisma.strategicAction.findMany({
      where: {
        companyId,
        type: 'MARKETING',
        status: { in: ['SUGGESTED', 'APPROVED'] },
        createdAt: { gte: this.addDays(new Date(), -30) },
      },
      take: 3,
    });

    const productLines = products.length
      ? products.map(
          (p) =>
            `- ${p.name} (categoria: ${p.category ?? 'n/d'}) | preço: R$ ${Number(p.price).toFixed(2)} | estoque: disponível`,
        )
      : ['Nenhum produto específico encontrado; peça detalhes.'];

    const promoLines = promos.length
      ? promos.map((p) => `- ${p.title}: ${p.description}`)
      : ['Sem promoções cadastradas no momento.'];

    const context = [
      `Produtos relevantes:\n${productLines.join('\n')}`,
      `Promoções:\n${promoLines.join('\n')}`,
    ].join('\n\n');

    const lastQuotedValue = products[0]?.price ? new Prisma.Decimal(products[0].price) : undefined;
    return { context, lastQuotedValue };
  }

  private async scoreLead(
    companyId: string,
    lead: { id: string; score: number; status: LeadStatus },
    text: string,
    lastQuotedValue?: Prisma.Decimal,
  ) {
    let delta = 0;
    const lower = text.toLowerCase();
    if (this.containsKeyword(lower, ['preco', 'preço', 'quanto'])) delta += 30;
    if (this.containsKeyword(lower, ['pagamento', 'cartao', 'pix', 'parcel'])) delta += 20;
    if (this.containsKeyword(lower, ['estoque', 'tem', 'disponivel'])) delta += 20;
    if (this.containsKeyword(lower, ['comprar', 'fechar', 'pedido'])) delta += 25;

    let newStatus = lead.status;
    if (delta > 0 && lead.status === LeadStatus.NEW && lead.score + delta >= QUALIFIED_THRESHOLD) {
      newStatus = LeadStatus.QUALIFIED;
    }
    if (this.containsKeyword(lower, ['paguei', 'comprei', 'fechado'])) {
      newStatus = LeadStatus.CONVERTED;
      delta = Math.max(delta, 40);
    }

    const score = Math.min(100, lead.score + delta);
    const data: Prisma.LeadUpdateInput = {
      score,
      status: newStatus,
      lastInteraction: new Date(),
    };
    if (lastQuotedValue) {
      data.lastQuotedValue = lastQuotedValue;
    }

    const updated = await this.prisma.lead.update({
      where: { id: lead.id },
      data,
    });

    if (score >= HOT_SCORE_THRESHOLD) {
      await this.alertsService.createAlert({
        companyId,
        type: 'LEAD_HOT',
        severity: 'HIGH',
        message: `Lead quente detectado! ${updated.name ?? 'Cliente'} está pronto para comprar.`,
      });
    }

    return updated;
  }

  private async getOrCreateConfig(companyId: string) {
    const existing = await this.prisma.botConfig.findUnique({ where: { companyId } });
    if (existing) return existing;

    return this.prisma.botConfig.create({
      data: {
        companyId,
        botName: 'Atendente IA',
        toneOfVoice: 'amigavel',
        welcomeMessage: 'Oi! Sou o assistente virtual da empresa, posso ajudar?',
      },
    });
  }

  // ─── Payload Extraction ────────────────────────────────────────────────────

  private extractWhatsappMessages(payload: Record<string, unknown>) {
    const messages: Array<{ from: string; text: string; name?: string | null }> = [];
    const entries = (payload?.['entry'] as Array<Record<string, unknown>>) || [];

    for (const entry of entries) {
      const changes = (entry?.['changes'] as Array<Record<string, unknown>>) || [];
      for (const change of changes) {
        const value = (change as { value?: Record<string, unknown> })?.value || {};
        const contacts = (value['contacts'] as Array<Record<string, unknown>>) || [];
        const profile = contacts[0]?.['profile'] as Record<string, unknown> | undefined;
        const contactName = typeof profile?.name === 'string' ? profile.name : undefined;
        const msgs = (value['messages'] as Array<Record<string, unknown>>) || [];
        for (const msg of msgs) {
          const from = (msg['from'] as string) || '';
          const text = (msg['text'] as { body?: string })?.body || (msg['button'] as { text?: string })?.text;
          if (from && text) {
            messages.push({ from, text, name: contactName });
          }
        }
      }
    }

    return messages;
  }

  private extractInstagramMessages(payload: Record<string, unknown>) {
    const messages: Array<{ from: string; text: string; name?: string | null }> = [];
    const entries = (payload?.['entry'] as Array<Record<string, unknown>>) || [];

    for (const entry of entries) {
      const messaging = (entry?.['messaging'] as Array<Record<string, unknown>>) || [];
      for (const event of messaging) {
        const sender = event['sender'] as Record<string, unknown> | undefined;
        const message = event['message'] as Record<string, unknown> | undefined;
        const from = typeof sender?.['id'] === 'string' ? sender['id'] : '';
        const text = typeof message?.['text'] === 'string' ? message['text'] : '';
        if (from && text && !message?.['is_echo']) {
          messages.push({ from, text, name: null });
        }
      }
    }

    return messages;
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private containsKeyword(text: string, keywords: string[]) {
    const lower = text.toLowerCase();
    return keywords.some((k) => lower.includes(k.toLowerCase()));
  }

  private addDays(date: Date, days: number) {
    const clone = new Date(date);
    clone.setDate(clone.getDate() + days);
    return clone;
  }

  private addHours(date: Date, hours: number) {
    const clone = new Date(date);
    clone.setHours(clone.getHours() + hours);
    return clone;
  }
}
