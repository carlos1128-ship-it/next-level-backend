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
import { AttendantActionService } from '../attendant-actions/attendant-action.service';
import { AttendantActionAnalysis } from '../attendant-actions/attendant-action.types';
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
  integrationEventId?: string;
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
    private readonly attendantActionService: AttendantActionService,
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
        integrationEventId: eventId,
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
    recipientId: string;
    text: string;
    dryRun?: boolean;
  }) {
    const normalized: NormalizedInstagramMessage = {
      instagramAccountId: input.recipientId,
      pageId: input.recipientId,
      senderId: input.senderId,
      recipientId: input.recipientId,
      messageId: `internal-test:${Date.now()}:${input.senderId}`,
      text: input.text,
      timestamp: new Date().toISOString(),
      contentType: 'text',
      raw: {
        source: 'internal_test',
        senderId: input.senderId,
        recipientId: input.recipientId,
      },
    };
    const resolution =
      await this.instagramIntegrationService.resolveAccountForWebhookDetailed({
        instagramAccountId: input.recipientId,
        pageId: input.recipientId,
        recipientId: input.recipientId,
        entryId: input.recipientId,
      });

    if (!resolution.account || resolution.account.companyId !== input.companyId) {
      return {
        processed: false,
        status: 'unresolved',
        matched: Boolean(resolution.account),
        matchedBy: resolution.matchedBy,
        errorMessage: 'Conta Instagram nao resolvida pelo recipientId informado',
      };
    }

    return this.processNormalizedMessage(normalized, {
      dryRun: input.dryRun !== false,
      source: 'internal_test',
    }, resolution.account.companyId);
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

    const config = await this.getAgentConfig(companyId);
    this.logger.log(
      JSON.stringify({
        event: 'instagram.ai.agent_config.loaded',
        companyId,
        attendantActive: Boolean(config.isEnabled && config.isOnline),
        model: config.modelName || null,
        promptSource: 'AgentConfig',
        fallbackUsed: false,
      }),
    );
    this.logPipelineStage('instagram.pipeline.after_agent_config', {
      companyId,
      conversationId: conversation.id,
      messageId: inbound.messageId,
      integrationEventId: options.integrationEventId,
      stage: 'after_agent_config',
      success: true,
    });

    if (conversation.isPaused && conversation.botPaused && !this.isExplicitHumanHandoff(message.text)) {
      await this.prisma.conversation.update({
        where: { id: conversation.id },
        data: {
          isPaused: false,
          botPaused: false,
          pausedUntil: null,
          status: 'Aguardando',
        },
      });
      conversation.isPaused = false;
      conversation.botPaused = false;
      conversation.pausedUntil = null;
      this.logPipelineStage('instagram.pipeline.bot_pause_cleared', {
        companyId,
        conversationId: conversation.id,
        messageId: inbound.messageId,
        integrationEventId: options.integrationEventId,
        stage: 'bot_pause_cleared',
        success: true,
      });
    }

    const pauseState = this.resolvePauseState(conversation, config);

    if (pauseState.paused) {
      await this.prisma.conversation.update({
        where: { id: conversation.id },
        data: {
          status: pauseState.status,
          lastMessageAt: new Date(message.timestamp),
        },
      });
      this.logPipelineStage('instagram.dm.send_skipped', {
        companyId,
        conversationId: conversation.id,
        messageId: inbound.messageId,
        integrationEventId: options.integrationEventId,
        stage: 'send_skipped',
        success: false,
        reason: pauseState.reason === 'agent_inactive' ? 'attendant_inactive' : 'pause_for_human',
      });
      return {
        processed: true,
        status: 'human_required',
        conversationId: conversation.id,
        reason: pauseState.reason,
      };
    }

    const actionAnalysis = await this.runActionLayer({
      companyId,
      conversationId: conversation.id,
      inboundMessageId: inbound.messageId,
      message,
      dryRun: options.dryRun,
      integrationEventId: options.integrationEventId,
    });

    const deterministicReply = this.buildFinalActionReply(actionAnalysis);
    if (deterministicReply) {
      this.logger.log(
        JSON.stringify({
          event: 'attendant.action.ai_call_skipped_for_template',
          companyId,
          conversationId: conversation.id,
          integrationEventId: options.integrationEventId || null,
          intent: actionAnalysis?.intent || null,
          assistantInstruction: actionAnalysis?.assistantInstruction || null,
        }),
      );
      return this.createAndMaybeSendOutbound({
        companyId,
        conversationId: conversation.id,
        recipientId: message.senderId,
        businessAccountId: message.recipientId,
        text: deterministicReply,
        actionAnalysis,
        dryRun: options.dryRun,
        source: options.source,
        statusAfterSend: options.dryRun ? 'IA preview' : 'IA respondeu',
        integrationEventId: options.integrationEventId,
      });
    }

    let reply: string;
    try {
      this.logPipelineStage('instagram.pipeline.ai_generation_started', {
        companyId,
        conversationId: conversation.id,
        messageId: inbound.messageId,
        integrationEventId: options.integrationEventId,
        stage: 'ai_generation_started',
        success: true,
      });
      reply = await this.generateAiReply(
        companyId,
        conversation.id,
        message,
        config,
        actionAnalysis,
        options.integrationEventId,
      );
      this.logPipelineStage('instagram.pipeline.ai_generation_finished', {
        companyId,
        conversationId: conversation.id,
        messageId: inbound.messageId,
        integrationEventId: options.integrationEventId,
        stage: 'ai_generation_finished',
        success: true,
      });
    } catch (error) {
      const safeMessage = error instanceof Error ? error.message : 'Falha ao gerar resposta IA';
      this.logger.error(
        JSON.stringify({
          event: 'instagram.ai.generation_failed',
          companyId,
          conversationId: conversation.id,
          integrationEventId: options.integrationEventId || null,
          errorName: error instanceof Error ? error.name : 'UnknownError',
          message: safeMessage,
        }),
      );
      this.logPipelineStage('instagram.dm.send_skipped', {
        companyId,
        conversationId: conversation.id,
        messageId: inbound.messageId,
        integrationEventId: options.integrationEventId,
        stage: 'send_skipped',
        success: false,
        reason: 'ai_generation_failed',
      });
      await this.prisma.conversation.update({
        where: { id: conversation.id },
        data: { status: 'IA precisa de atencao', lastMessageAt: new Date(message.timestamp) },
      });
      return {
        processed: true,
        status: 'ai_failed',
        conversationId: conversation.id,
        errorMessage: safeMessage,
      };
    }

    if (!reply.trim()) {
      this.logger.warn(
        JSON.stringify({
          event: 'instagram.ai.empty_response',
          companyId,
          conversationId: conversation.id,
          integrationEventId: options.integrationEventId || null,
        }),
      );
      this.logPipelineStage('instagram.dm.send_skipped', {
        companyId,
        conversationId: conversation.id,
        messageId: inbound.messageId,
        integrationEventId: options.integrationEventId,
        stage: 'send_skipped',
        success: false,
        reason: 'ai_response_empty',
      });
      return {
        processed: true,
        status: 'ai_empty',
        conversationId: conversation.id,
        errorMessage: 'IA retornou resposta vazia',
      };
    }

    if (reply.toUpperCase().includes('PAUSAR_BOT')) {
      if (!this.isExplicitHumanHandoff(message.text) && actionAnalysis?.intent !== 'HUMAN_HANDOFF') {
        this.logger.warn(
          JSON.stringify({
            event: 'instagram.ai.unexpected_handoff_suppressed',
            companyId,
            conversationId: conversation.id,
            integrationEventId: options.integrationEventId || null,
            intent: actionAnalysis?.intent || null,
          }),
        );
        reply = this.buildActionFallbackReply(actionAnalysis);
      } else {
      const transferMessage = 'Um momento. Vou chamar um atendente humano.';
      await this.pauseConversation(conversation, message.senderId);
      return this.createAndMaybeSendOutbound({
        companyId,
        conversationId: conversation.id,
        recipientId: message.senderId,
        businessAccountId: message.recipientId,
        text: transferMessage,
        actionAnalysis,
        dryRun: options.dryRun,
        source: options.source,
        statusAfterSend: 'Humano acionado',
        integrationEventId: options.integrationEventId,
      });
      }
    }

    return this.createAndMaybeSendOutbound({
      companyId,
      conversationId: conversation.id,
      recipientId: message.senderId,
      businessAccountId: message.recipientId,
      text: reply,
      actionAnalysis,
      dryRun: options.dryRun,
      source: options.source,
      statusAfterSend: options.dryRun ? 'IA preview' : 'IA respondeu',
      integrationEventId: options.integrationEventId,
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
        companyId_provider_contactNumber: {
          companyId,
          provider: IntegrationProvider.INSTAGRAM,
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
          customerExternalId: message.senderId,
          businessAccountId: message.recipientId,
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
    businessAccountId: string;
    text: string;
    actionAnalysis?: AttendantActionAnalysis | null;
    dryRun?: boolean;
    source?: string;
    statusAfterSend: string;
    integrationEventId?: string;
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
          outboundRecipientId: input.recipientId,
          businessAccountId: input.businessAccountId,
          intent: input.actionAnalysis?.intent || null,
          actionStatus: input.actionAnalysis?.actionStatus || null,
          appointmentRequestId: input.actionAnalysis?.appointmentRequestId || null,
          saleId: input.actionAnalysis?.saleId || null,
          financialTransactionId:
            input.actionAnalysis?.financialTransactionId || null,
          businessActionRequestId:
            input.actionAnalysis?.businessActionRequestId || null,
          customerId: input.actionAnalysis?.customerId || null,
          leadId: input.actionAnalysis?.leadId || null,
        }),
      },
    });

    if (!input.dryRun) {
      this.logPipelineStage('instagram.pipeline.send_started', {
        companyId: input.companyId,
        conversationId: input.conversationId,
        messageId: outbound.id,
        integrationEventId: input.integrationEventId,
        stage: 'send_started',
        success: true,
      });
      await this.instagramSendService.sendInstagramMessage(
        input.companyId,
        input.recipientId,
        input.text,
        { messageId: outbound.id, businessAccountId: input.businessAccountId },
      );
      this.logPipelineStage('instagram.pipeline.send_finished', {
        companyId: input.companyId,
        conversationId: input.conversationId,
        messageId: outbound.id,
        integrationEventId: input.integrationEventId,
        stage: 'send_finished',
        success: true,
      });
    } else {
      this.logPipelineStage('instagram.dm.send_skipped', {
        companyId: input.companyId,
        conversationId: input.conversationId,
        messageId: outbound.id,
        integrationEventId: input.integrationEventId,
        stage: 'send_skipped',
        success: true,
        reason: 'dry_run',
      });
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
      intent: input.actionAnalysis?.intent || null,
      extractedFields: input.actionAnalysis?.extractedFields || null,
      missingFields: input.actionAnalysis?.missingFields || [],
      actionStatus: input.actionAnalysis?.actionStatus || null,
      actionCreated: Boolean(input.actionAnalysis?.actionCreated),
      leadId: input.actionAnalysis?.leadId || null,
      appointmentRequestId: input.actionAnalysis?.appointmentRequestId || null,
      saleId: input.actionAnalysis?.saleId || null,
      financialTransactionId: input.actionAnalysis?.financialTransactionId || null,
      businessActionRequestId: input.actionAnalysis?.businessActionRequestId || null,
      customerId: input.actionAnalysis?.customerId || null,
      shouldCreateCustomer: Boolean(input.actionAnalysis?.shouldCreateCustomer),
      shouldCreateActionRequest: Boolean(
        input.actionAnalysis?.shouldCreateActionRequest,
      ),
      nextAssistantInstruction: input.actionAnalysis?.nextAssistantInstruction || null,
      shouldFinalize: Boolean(input.actionAnalysis?.shouldFinalize),
      registrationClaimAllowed: Boolean(input.actionAnalysis?.registrationClaimAllowed),
      userConfirmed: Boolean(input.actionAnalysis?.userConfirmed),
    };
  }

  private async runActionLayer(input: {
    companyId: string;
    conversationId: string;
    inboundMessageId: string;
    message: NormalizedInstagramMessage;
    dryRun?: boolean;
    integrationEventId?: string;
  }) {
    this.logPipelineStage('instagram.pipeline.action_processing_started', {
      companyId: input.companyId,
      conversationId: input.conversationId,
      messageId: input.inboundMessageId,
      integrationEventId: input.integrationEventId,
      stage: 'action_processing_started',
      success: true,
    });
    try {
      const analysis = await this.attendantActionService.analyzeAndPrepare({
        companyId: input.companyId,
        conversationId: input.conversationId,
        sourceMessageId: input.inboundMessageId,
        channel: 'instagram',
        provider: IntegrationProvider.INSTAGRAM,
        customerExternalId: input.message.senderId,
        businessAccountId: input.message.recipientId,
        text: input.message.text,
        dryRun: input.dryRun,
      });

      await this.prisma.message.update({
        where: { id: input.inboundMessageId },
        data: {
          metadata: this.toJson({
            provider: 'instagram',
            channel: 'instagram',
            senderId: input.message.senderId,
            recipientId: input.message.recipientId,
            customerExternalId: input.message.senderId,
            businessAccountId: input.message.recipientId,
            instagramAccountId: input.message.instagramAccountId,
            entryId: input.message.entryId,
            intent: analysis.intent,
            extractedFields: analysis.extractedFields,
            missingFields: analysis.missingFields,
            actionStatus: analysis.actionStatus,
            shouldCreateCustomer: analysis.shouldCreateCustomer,
            shouldCreateActionRequest: analysis.shouldCreateActionRequest,
            customerCreatedOrUpdated: analysis.customerCreatedOrUpdated,
            businessActionRequestCreatedOrUpdated:
              analysis.businessActionRequestCreatedOrUpdated,
            appearsInCustomers: analysis.appearsInCustomers,
            registrationClaimAllowed: analysis.registrationClaimAllowed,
            nextAssistantInstruction: analysis.nextAssistantInstruction,
            customerId: analysis.customerId || null,
            leadId: analysis.leadId || null,
            saleId: analysis.saleId || null,
            financialTransactionId: analysis.financialTransactionId || null,
            businessActionRequestId: analysis.businessActionRequestId || null,
            appointmentRequestId: analysis.appointmentRequestId || null,
          }),
        },
      });

      this.logPipelineStage('instagram.pipeline.action_processing_finished', {
        companyId: input.companyId,
        conversationId: input.conversationId,
        messageId: input.inboundMessageId,
        integrationEventId: input.integrationEventId,
        stage: 'action_processing_finished',
        success: true,
      });
      return analysis;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Falha na camada de acao';
      this.logger.warn(
        JSON.stringify({
          event: 'instagram.action_layer.failed',
          alias: 'attendant.action.processing_failed',
          companyId: input.companyId,
          conversationId: input.conversationId,
          inboundMessageId: input.inboundMessageId,
          integrationEventId: input.integrationEventId || null,
          message,
        }),
      );
      this.logPipelineStage('instagram.pipeline.action_processing_finished', {
        companyId: input.companyId,
        conversationId: input.conversationId,
        messageId: input.inboundMessageId,
        integrationEventId: input.integrationEventId,
        stage: 'action_processing_finished',
        success: false,
      });
      await this.prisma.conversation
        .update({
          where: { id: input.conversationId },
          data: { status: 'Acao pendente' },
        })
        .catch(() => null);
      return null;
    }
  }

  private async generateAiReply(
    companyId: string,
    conversationId: string,
    currentMessage: NormalizedInstagramMessage,
    config: AgentConfig,
    actionAnalysis?: AttendantActionAnalysis | null,
    integrationEventId?: string,
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
      actionContext:
        actionAnalysis?.promptContext ||
        'Camada de acao: nenhuma acao estruturada detectada nesta mensagem.',
    });

    const result = await this.aiService.generateText(prompt, companyId, 'simple', {
      feature: AIUsageFeature.INSTAGRAM_AGENT,
      metadata: {
        source: 'instagram_dm_pipeline',
        channel: 'instagram',
        conversationId,
        promptSource: 'AgentConfig',
      },
    });
    const response = result.text.trim();

    this.logger.log(
      JSON.stringify({
        event: 'instagram.ai.response.generated',
        companyId,
        conversationId,
        integrationEventId: integrationEventId || null,
        model: config.modelName || null,
        promptSource: 'AgentConfig',
        fallbackUsed: false,
        aiResponseGenerated: Boolean(response),
      }),
    );

    if (!response) {
      throw new Error('IA nao gerou resposta para Instagram');
    }

    return response;
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
    actionContext: string;
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
      'Nao use asteriscos, negrito markdown ou decoracao markdown na resposta final.',
      'Nao invente preco, estoque, prazo ou politica. Se faltar dado, pergunte objetivamente ou diga que a equipe vai confirmar.',
      'Responda PAUSAR_BOT somente se o cliente pedir explicitamente atendimento humano.',
      `Mensagem inicial/regras: ${input.welcomeMessage}`,
      `System prompt configurado: ${input.systemPrompt}`,
      `Instrucoes da empresa: ${input.instructions}`,
      `Contexto de negocio:\n${input.rag || 'Sem contexto adicional.'}`,
      `Contexto de intent/action:\n${input.actionContext}`,
      'Regras de agendamento: se faltar dia, horario ou servico, pergunte objetivamente. Se houver pedido salvo sem agenda real, diga que a solicitacao foi registrada para confirmacao da equipe. Nao diga que esta confirmado sem disponibilidade real.',
      'Regra anti-confirmacao repetida: nao peca para confirmar informacoes que ja estao explicitas. Se o sistema disser que a solicitacao foi salva, conclua em uma frase curta. Se o cliente ja disse sim, correto, isso, exatamente, pode ser ou confirmo, nao pergunte novamente.',
      'Regras de dados do cliente: se o cliente informar nome, telefone ou email, reconheca naturalmente e continue o atendimento.',
      `Historico recente do Instagram:\n${historyText}`,
      `Mensagem atual do cliente: ${input.customerMessage}`,
    ].join('\n\n');
  }

  private async getAgentConfig(companyId: string) {
    const config = await this.prisma.agentConfig.findUnique({
      where: { companyId },
    });

    if (!config) {
      throw new Error('AgentConfig nao configurado para a empresa');
    }

    return config;
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

  private buildActionFallbackReply(actionAnalysis?: AttendantActionAnalysis | null) {
    if (actionAnalysis?.registrationClaimAllowed) {
      const fields = actionAnalysis.extractedFields || {};
      const service = fields.requestedService || fields.objective || 'solicitacao';
      const dateText = [fields.desiredDate, fields.desiredTime].filter(Boolean).join(' as ');
      return dateText
        ? `Perfeito, registrei sua solicitacao de ${service} para ${dateText}. A equipe vai confirmar o horario com voce.`
        : `Perfeito, registrei sua solicitacao de ${service}. A equipe vai confirmar com voce.`;
    }

    const missing = actionAnalysis?.missingFields || [];
    if (missing.includes('customerName') || missing.includes('phone')) {
      return 'Claro, posso te ajudar. Para registrar sua solicitacao, me informe seu nome e telefone para contato.';
    }
    if (missing.includes('requestedService')) {
      return 'Claro. Qual servico ou assunto voce deseja agendar?';
    }
    if (missing.includes('desiredDate') || missing.includes('desiredTime')) {
      return 'Perfeito. Para qual dia e horario voce prefere?';
    }
    return 'Claro, posso te ajudar. Me diga um pouco mais sobre o que voce precisa.';
  }

  private buildFinalActionReply(actionAnalysis?: AttendantActionAnalysis | null) {
    if (!actionAnalysis?.shouldFinalize || !actionAnalysis.registrationClaimAllowed) {
      return null;
    }

    const fields = actionAnalysis.extractedFields || {};
    if (actionAnalysis.userConfirmed && !actionAnalysis.justSaved) {
      return 'Perfeito, sua solicitacao ja esta registrada. A equipe vai confirmar com voce.';
    }

    const firstName = fields.customerName?.split(/\s+/)[0] || null;
    const service = fields.requestedService || fields.objective || 'solicitacao';
    const desiredDate = fields.desiredDate ? this.formatDateOnly(fields.desiredDate) : null;
    const desiredTime = fields.desiredTime || null;
    const target = [desiredDate, desiredTime ? `${desiredTime}` : null]
      .filter(Boolean)
      .join(' as ');
    const greeting = firstName ? `Perfeito, ${firstName}.` : 'Perfeito.';

    if (target) {
      return `${greeting} Registrei sua solicitacao de ${service} para ${target}. A equipe vai confirmar com voce.`;
    }

    return `${greeting} Registrei sua solicitacao de ${service}. A equipe vai confirmar com voce.`;
  }

  private formatDateOnly(value: string) {
    const [year, month, day] = value.split('-');
    return year && month && day ? `${day}/${month}/${year}` : value;
  }

  private isExplicitHumanHandoff(text: string) {
    const normalized = text
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
    return [
      'falar com humano',
      'falar com atendente',
      'pessoa real',
      'atendente humano',
      'chamar atendente',
      'quero humano',
      'quero atendente',
    ].some((term) => normalized.includes(term));
  }

  private logPipelineStage(
    event: string,
    input: {
      companyId: string;
      conversationId?: string | null;
      messageId?: string | null;
      integrationEventId?: string | null;
      stage: string;
      success: boolean;
      reason?: string | null;
    },
  ) {
    this.logger.log(
      JSON.stringify({
        event,
        companyId: input.companyId,
        conversationId: input.conversationId || null,
        messageId: input.messageId || null,
        integrationEventId: input.integrationEventId || null,
        channel: 'instagram',
        stage: input.stage,
        success: input.success,
        reason: input.reason || null,
      }),
    );
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
