import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  AttendantActionAnalysis,
  AttendantActionInput,
  AttendantActionStatus,
  AttendantIntent,
  ExtractedAttendantFields,
} from './attendant-action.types';
import { AttendantContextService } from './attendant-context.service';
import { AttendantDataExtractionService } from './attendant-data-extraction.service';
import { AttendantIntentService } from './attendant-intent.service';

const LEAD_INTENTS: AttendantIntent[] = [
  'SCHEDULE_REQUEST',
  'MEETING_REQUEST',
  'SERVICE_REQUEST',
  'QUOTE_REQUEST',
  'PRODUCT_INTEREST',
  'CUSTOMER_DATA_CAPTURE',
  'SERVICE_INFORMATION',
  'HUMAN_HANDOFF',
];

const ACTIVE_ACTION_TTL_MS = 6 * 60 * 60 * 1000;

@Injectable()
export class AttendantActionService {
  private readonly logger = new Logger(AttendantActionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly intentService: AttendantIntentService,
    private readonly extractionService: AttendantDataExtractionService,
    private readonly contextService: AttendantContextService,
  ) {}

  async analyzeAndPrepare(input: AttendantActionInput): Promise<AttendantActionAnalysis> {
    const detectedIntent = this.intentService.detectIntent(input.text);
    const currentFields = this.extractionService.extract(input.text);
    this.logger.log(
      JSON.stringify({
        event: 'attendant.action.intent_detected',
        companyId: input.companyId,
        channel: input.channel,
        provider: input.provider,
        intent: detectedIntent,
      }),
    );
    this.logger.log(
      JSON.stringify({
        event: 'attendant.action.fields_extracted',
        companyId: input.companyId,
        hasCustomerName: Boolean(currentFields.customerName),
        hasPhone: Boolean(currentFields.phone),
        hasEmail: Boolean(currentFields.email),
        hasRequestedService: Boolean(currentFields.requestedService),
        hasDesiredDate: Boolean(currentFields.desiredDate),
        hasDesiredTime: Boolean(currentFields.desiredTime),
      }),
    );
    const existingDraft = input.conversationId
      ? await this.findActiveActionDraft(input, detectedIntent, currentFields)
      : null;
    const effectiveIntent = this.resolveEffectiveIntent(detectedIntent, existingDraft?.type);
    const extractedFields = this.mergeExtractedFields(
      this.readDraftFields(existingDraft?.metadata),
      currentFields,
    );
    const missingFields = this.extractionService.missingForIntent(
      effectiveIntent,
      extractedFields,
    );
    this.logger.log(
      JSON.stringify({
        event: 'attendant.action.missing_fields',
        companyId: input.companyId,
        intent: effectiveIntent,
        missingFields,
      }),
    );
    const actionStatus = this.resolveActionStatus(effectiveIntent, missingFields);
    const companyContext = await this.contextService.buildCompanyActionContext(input.companyId);
    const leadIntent = this.isLeadIntent(effectiveIntent);
    const shouldCreateCustomer = leadIntent && this.hasCustomerMinimum(extractedFields);
    const shouldCreateActionRequest =
      shouldCreateCustomer && this.hasActionMinimum(effectiveIntent, extractedFields);
    let appearsInCustomers = false;

    if (input.dryRun || !leadIntent) {
      return this.buildAnalysis({
        intent: effectiveIntent,
        extractedFields,
        missingFields,
        actionStatus,
        companyContext,
        shouldCreateCustomer,
        shouldCreateActionRequest,
        actionCreated: false,
        draftSaved: false,
        appearsInCustomers,
      });
    }

    const shouldSaveActionDraft =
      Boolean(input.conversationId) &&
      (effectiveIntent !== 'CUSTOMER_DATA_CAPTURE' || Boolean(existingDraft));
    let customer: { id: string; operation: 'created' | 'updated' } | null = null;
    let lead: { id: string } | null = null;

    if (shouldCreateCustomer) {
      this.logger.log(
        JSON.stringify({
          event: 'attendant.action.customer_save.started',
          companyId: input.companyId,
          channel: input.channel,
          provider: input.provider,
          intent: effectiveIntent,
          hasPhone: Boolean(extractedFields.phone),
          hasEmail: Boolean(extractedFields.email),
          hasInterest: Boolean(extractedFields.requestedService || extractedFields.objective),
        }),
      );

      try {
        customer = await this.upsertCustomer(input, effectiveIntent, actionStatus, extractedFields);
        appearsInCustomers = customer?.id
          ? await this.customerAppearsInCustomers(input.companyId, customer.id)
          : false;
        this.logger.log(
          JSON.stringify({
            event: 'attendant.action.customer_save.succeeded',
            companyId: input.companyId,
            channel: input.channel,
            provider: input.provider,
            customerId: customer?.id || null,
            appearsInCustomers,
          }),
        );
      } catch (error) {
        this.logger.error(
          JSON.stringify({
            event: 'attendant.action.customer_save.failed',
            companyId: input.companyId,
            channel: input.channel,
            provider: input.provider,
            message: error instanceof Error ? error.message : 'Falha ao salvar cliente IA',
          }),
        );
        throw error;
      }

      lead = await this.upsertLead(input, effectiveIntent, actionStatus, extractedFields);
    }

    let request: { id: string; operation: 'created' | 'updated' } | null = null;
    if (shouldSaveActionDraft) {
      this.logger.log(
        JSON.stringify({
          event: 'attendant.action.business_request_save.started',
          companyId: input.companyId,
          channel: input.channel,
          provider: input.provider,
          intent: effectiveIntent,
          status: actionStatus,
          customerLinked: Boolean(customer?.id),
          leadLinked: Boolean(lead?.id),
        }),
      );
      try {
        request = await this.upsertBusinessActionRequest({
          input,
          existingId: existingDraft?.id || null,
          intent: effectiveIntent,
          status: actionStatus,
          fields: extractedFields,
          customerId: customer?.id || null,
          leadId: lead?.id || null,
        });
        this.logger.log(
          JSON.stringify({
            event: 'attendant.action.business_request_save.succeeded',
            companyId: input.companyId,
            businessActionRequestId: request?.id || null,
            status: actionStatus,
          }),
        );
      } catch (error) {
        this.logger.error(
          JSON.stringify({
            event: 'attendant.action.business_request_save.failed',
            companyId: input.companyId,
            channel: input.channel,
            provider: input.provider,
            message:
              error instanceof Error ? error.message : 'Falha ao salvar pedido de acao IA',
          }),
        );
        throw error;
      }
    }

    const actionCreated = Boolean(
      customer?.id &&
        appearsInCustomers &&
        (shouldCreateActionRequest || effectiveIntent === 'CUSTOMER_DATA_CAPTURE'),
    );

    this.logger.log(
      JSON.stringify({
        event: 'attendant.action.detected',
        companyId: input.companyId,
        channel: input.channel,
        provider: input.provider,
        intent: effectiveIntent,
        actionStatus,
        customerCreatedOrUpdated: Boolean(customer?.id),
        leadCreatedOrUpdated: Boolean(lead?.id),
        businessActionRequestId: request?.id || null,
        appearsInCustomers,
        registrationClaimAllowed: actionCreated,
        missingFields,
      }),
    );
    this.logger.log(
      JSON.stringify({
        event: 'attendant.action.registration_claim_allowed',
        companyId: input.companyId,
        allowed: actionCreated,
        appearsInCustomers,
        customerId: customer?.id || null,
        businessActionRequestId: request?.id || null,
      }),
    );

    return this.buildAnalysis({
      intent: effectiveIntent,
      extractedFields,
      missingFields,
      actionStatus,
      companyContext,
      shouldCreateCustomer,
      shouldCreateActionRequest,
      actionCreated,
      draftSaved: Boolean(request?.id),
      customerId: customer?.id || null,
      leadId: lead?.id || null,
      businessActionRequestId: request?.id || null,
      customerCreatedOrUpdated: Boolean(customer?.id),
      customerCreated: customer?.operation === 'created',
      customerUpdated: customer?.operation === 'updated',
      leadCreatedOrUpdated: Boolean(lead?.id),
      businessActionRequestCreatedOrUpdated: Boolean(request?.id),
      businessActionRequestCreated: request?.operation === 'created',
      appearsInCustomers,
    });
  }

  async preview(input: AttendantActionInput) {
    return this.analyzeAndPrepare({ ...input, dryRun: true });
  }

  private async findActiveActionDraft(
    input: AttendantActionInput,
    detectedIntent: AttendantIntent,
    currentFields: ExtractedAttendantFields,
  ) {
    if (!input.conversationId) {
      return null;
    }

    if (this.startsNewActionSession(detectedIntent, input.text)) {
      this.logger.log(
        JSON.stringify({
          event: 'attendant.action.session.started',
          companyId: input.companyId,
          conversationId: input.conversationId,
          intent: detectedIntent,
        }),
      );
      return null;
    }

    const updatedAfter = new Date(Date.now() - ACTIVE_ACTION_TTL_MS);
    const needsInfoDraft = await this.prisma.businessActionRequest.findFirst({
      where: {
        companyId: input.companyId,
        conversationId: input.conversationId,
        status: { in: ['NEEDS_INFO', 'PENDING_DATA'] },
        updatedAt: { gte: updatedAfter },
      },
      orderBy: { updatedAt: 'desc' },
      select: { id: true, type: true, status: true, metadata: true, updatedAt: true },
    });
    if (needsInfoDraft) {
      return needsInfoDraft;
    }

    if (!this.looksLikeCustomerUpdate(input.text, currentFields)) {
      return null;
    }

    return this.prisma.businessActionRequest.findFirst({
      where: {
        companyId: input.companyId,
        conversationId: input.conversationId,
        customerExternalId: input.customerExternalId,
        status: 'PENDING_CONFIRMATION',
        updatedAt: { gte: updatedAfter },
      },
      orderBy: { updatedAt: 'desc' },
      select: { id: true, type: true, status: true, metadata: true, updatedAt: true },
    });
  }

  private async upsertCustomer(
    input: AttendantActionInput,
    intent: AttendantIntent,
    actionStatus: AttendantActionStatus,
    fields: ExtractedAttendantFields,
  ) {
    const existing = await this.findExistingCustomer(input, fields);
    const ownerNote = this.buildOwnerNote(input, fields);
    const data = {
      name: fields.customerName || 'Cliente IA',
      email: fields.email || undefined,
      phone: fields.phone || undefined,
      channel: input.channel,
      provider: input.provider,
      externalCustomerId: input.customerExternalId,
      sourceConversationId: input.conversationId || undefined,
      sourceMessageId: input.sourceMessageId || undefined,
      source: `ia_${input.channel}`,
      interest: fields.requestedService || fields.objective || undefined,
      objective: fields.objective || ownerNote,
      desiredDate: this.parseDate(fields.desiredDate) || undefined,
      desiredTime: fields.desiredTime || undefined,
      status: actionStatus,
      metadata: this.toJson(this.buildMetadata(input, intent, fields, ownerNote)),
    };

    if (existing) {
      const updated = await this.prisma.customer.update({
        where: { id: existing.id },
        data,
        select: { id: true },
      });
      return { id: updated.id, operation: 'updated' as const };
    }

    const created = await this.prisma.customer.create({
      data: {
        companyId: input.companyId,
        ...data,
        email: fields.email || null,
        phone: fields.phone || null,
        desiredDate: this.parseDate(fields.desiredDate),
        desiredTime: fields.desiredTime || null,
      },
      select: { id: true },
    });
    return { id: created.id, operation: 'created' as const };
  }

  private async upsertLead(
    input: AttendantActionInput,
    intent: AttendantIntent,
    actionStatus: AttendantActionStatus,
    fields: ExtractedAttendantFields,
  ) {
    const externalId = `${input.channel}:${input.customerExternalId}`;
    const ownerNote = this.buildOwnerNote(input, fields);
    return this.prisma.lead.upsert({
      where: {
        companyId_externalId: {
          companyId: input.companyId,
          externalId,
        },
      },
      update: {
        name: fields.customerName || undefined,
        email: fields.email || undefined,
        phone: fields.phone || undefined,
        channel: input.channel,
        provider: input.provider,
        externalCustomerId: input.customerExternalId,
        sourceConversationId: input.conversationId || undefined,
        latestIntent: intent,
        actionStatus,
        requestedService: fields.requestedService || fields.objective || undefined,
        requestedDate: this.parseDate(fields.desiredDate) || undefined,
        requestedTime: fields.desiredTime || undefined,
        notes: ownerNote,
        metadata: this.toJson(this.buildMetadata(input, intent, fields, ownerNote)),
        lastInteraction: new Date(),
        score: this.scoreIntent(intent),
      },
      create: {
        companyId: input.companyId,
        externalId,
        name: fields.customerName || null,
        email: fields.email || null,
        phone: fields.phone || null,
        channel: input.channel,
        provider: input.provider,
        externalCustomerId: input.customerExternalId,
        sourceConversationId: input.conversationId || null,
        latestIntent: intent,
        actionStatus,
        requestedService: fields.requestedService || fields.objective || null,
        requestedDate: this.parseDate(fields.desiredDate),
        requestedTime: fields.desiredTime || null,
        notes: ownerNote,
        metadata: this.toJson(this.buildMetadata(input, intent, fields, ownerNote)),
        lastInteraction: new Date(),
        score: this.scoreIntent(intent),
        status: 'NEW',
      },
      select: { id: true },
    });
  }

  private async upsertBusinessActionRequest(input: {
    input: AttendantActionInput;
    existingId?: string | null;
    intent: AttendantIntent;
    status: AttendantActionStatus;
    fields: ExtractedAttendantFields;
    customerId?: string | null;
    leadId?: string | null;
  }) {
    const ownerNote = this.buildOwnerNote(input.input, input.fields);
    const data = {
      customerId: input.customerId || undefined,
      leadId: input.leadId || undefined,
      sourceMessageId: input.input.sourceMessageId || undefined,
      type: input.intent,
      status: input.status,
      customerName: input.fields.customerName || undefined,
      phone: input.fields.phone || undefined,
      email: input.fields.email || undefined,
      requestedService: input.fields.requestedService || input.fields.objective || undefined,
      objective: input.fields.objective || undefined,
      desiredDate: this.parseDate(input.fields.desiredDate) || undefined,
      desiredTime: input.fields.desiredTime || undefined,
      notes: ownerNote,
      metadata: this.toJson(this.buildMetadata(input.input, input.intent, input.fields, ownerNote)),
    };

    if (input.existingId) {
      const updated = await this.prisma.businessActionRequest.update({
        where: { id: input.existingId },
        data,
        select: { id: true },
      });
      return { id: updated.id, operation: 'updated' as const };
    }

    const created = await this.prisma.businessActionRequest.create({
      data: {
        companyId: input.input.companyId,
        conversationId: input.input.conversationId || '',
        channel: input.input.channel,
        provider: input.input.provider,
        customerExternalId: input.input.customerExternalId,
        customerId: input.customerId || null,
        leadId: input.leadId || null,
        sourceMessageId: input.input.sourceMessageId || null,
        type: input.intent,
        status: input.status,
        customerName: input.fields.customerName || null,
        phone: input.fields.phone || null,
        email: input.fields.email || null,
        requestedService: input.fields.requestedService || input.fields.objective || null,
        objective: input.fields.objective || null,
        desiredDate: this.parseDate(input.fields.desiredDate),
        desiredTime: input.fields.desiredTime || null,
        notes: ownerNote,
        metadata: data.metadata,
      },
      select: { id: true },
    });
    return { id: created.id, operation: 'created' as const };
  }

  private buildAnalysis(input: {
    intent: AttendantIntent;
    extractedFields: ExtractedAttendantFields;
    missingFields: string[];
    actionStatus: AttendantActionStatus;
    companyContext: string;
    shouldCreateCustomer: boolean;
    shouldCreateActionRequest: boolean;
    actionCreated: boolean;
    draftSaved: boolean;
    customerId?: string | null;
    leadId?: string | null;
    businessActionRequestId?: string | null;
    customerCreatedOrUpdated?: boolean;
    customerCreated?: boolean;
    customerUpdated?: boolean;
    leadCreatedOrUpdated?: boolean;
    businessActionRequestCreatedOrUpdated?: boolean;
    businessActionRequestCreated?: boolean;
    appearsInCustomers?: boolean;
  }): AttendantActionAnalysis {
    const nextAssistantInstruction = this.resolveNextInstruction(input);
    const registrationClaimAllowed = Boolean(input.actionCreated && input.appearsInCustomers);
    return {
      intent: input.intent,
      extractedFields: input.extractedFields,
      missingFields: input.missingFields,
      actionStatus: input.actionStatus,
      shouldCreateCustomer: input.shouldCreateCustomer,
      shouldCreateActionRequest: input.shouldCreateActionRequest,
      customerId: input.customerId || null,
      leadId: input.leadId || null,
      appointmentRequestId: null,
      businessActionRequestId: input.businessActionRequestId || null,
      actionCreated: input.actionCreated,
      draftSaved: input.draftSaved,
      customerCreatedOrUpdated: Boolean(input.customerCreatedOrUpdated),
      customerCreated: Boolean(input.customerCreated),
      customerUpdated: Boolean(input.customerUpdated),
      leadCreatedOrUpdated: Boolean(input.leadCreatedOrUpdated),
      businessActionRequestCreatedOrUpdated: Boolean(
        input.businessActionRequestCreatedOrUpdated,
      ),
      businessActionRequestCreated: Boolean(input.businessActionRequestCreated),
      appearsInCustomers: Boolean(input.appearsInCustomers),
      registrationClaimAllowed,
      ok: true,
      errorClassification: null,
      shouldContinueAiResponse: true,
      shouldAskMissingFields: input.missingFields.length > 0,
      shouldHumanHandoff: input.intent === 'HUMAN_HANDOFF',
      assistantInstruction: nextAssistantInstruction,
      nextAssistantInstruction,
      promptContext: this.buildPromptContext({
        ...input,
        registrationClaimAllowed,
        nextAssistantInstruction,
      }),
    };
  }

  private buildPromptContext(input: {
    intent: AttendantIntent;
    extractedFields: ExtractedAttendantFields;
    missingFields: string[];
    actionStatus: AttendantActionStatus;
    companyContext: string;
    shouldCreateCustomer: boolean;
    shouldCreateActionRequest: boolean;
    actionCreated: boolean;
    draftSaved: boolean;
    businessActionRequestId?: string | null;
    registrationClaimAllowed: boolean;
    nextAssistantInstruction: string;
  }) {
    return [
      'Camada de acao generica do Atendente IA:',
      `Intent detectada: ${input.intent}.`,
      `Campos acumulados na conversa: ${JSON.stringify(input.extractedFields)}.`,
      `Campos faltantes: ${input.missingFields.length ? input.missingFields.join(', ') : 'nenhum'}.`,
      `Status da acao: ${input.actionStatus}.`,
      `Cliente pode ser salvo agora: ${input.shouldCreateCustomer}.`,
      `Pedido/acao pode ser salvo agora: ${input.shouldCreateActionRequest}.`,
      input.registrationClaimAllowed
        ? `Cliente/lead e BusinessActionRequest salvos. ID: ${input.businessActionRequestId || 'salvo'}.`
        : input.draftSaved
          ? 'Rascunho interno atualizado; ainda nao diga que a solicitacao foi registrada, peca os dados faltantes.'
          : 'Nenhuma acao estruturada salva para esta mensagem.',
      `Pode afirmar que registrou a solicitacao: ${input.registrationClaimAllowed}.`,
      `Proxima instrucao: ${input.nextAssistantInstruction}.`,
      input.companyContext,
      'Regra obrigatoria: nao diga que esta confirmado sem disponibilidade real. So diga que registrou se "Pode afirmar que registrou a solicitacao" for true. Se for false, peca apenas os dados faltantes. Nao diga que vai chamar humano em fluxo normal; diga que a equipe vai confirmar o horario.',
    ].join('\n');
  }

  private resolveEffectiveIntent(detected: AttendantIntent, draftType?: string | null): AttendantIntent {
    const draftIntent = draftType as AttendantIntent;
    if (!this.isLeadIntent(draftIntent)) {
      return detected;
    }
    if (
      ['SCHEDULE_REQUEST', 'MEETING_REQUEST'].includes(draftIntent) &&
      [
        'GENERAL_QUESTION',
        'CUSTOMER_DATA_CAPTURE',
        'SERVICE_REQUEST',
        'SERVICE_INFORMATION',
        'QUOTE_REQUEST',
        'PRODUCT_INTEREST',
      ].includes(detected)
    ) {
      return draftType as AttendantIntent;
    }
    if (['CUSTOMER_DATA_CAPTURE', 'GENERAL_QUESTION'].includes(detected)) {
      return draftIntent;
    }
    return detected;
  }

  private mergeExtractedFields(
    existing: ExtractedAttendantFields,
    current: ExtractedAttendantFields,
  ): ExtractedAttendantFields {
    return {
      customerName: this.pickBestName(existing.customerName, current.customerName),
      phone: current.phone || existing.phone || null,
      email: current.email || existing.email || null,
      desiredDate: current.desiredDate || existing.desiredDate || null,
      desiredTime: current.desiredTime || existing.desiredTime || null,
      requestedService: current.requestedService || existing.requestedService || null,
      objective: current.objective || existing.objective || null,
      preferredContactMethod:
        current.preferredContactMethod || existing.preferredContactMethod || null,
      urgency: current.urgency || existing.urgency || null,
      budget: current.budget || existing.budget || null,
      notes: [existing.notes, current.notes].filter(Boolean).join(' | ') || null,
    };
  }

  private readDraftFields(metadata: unknown): ExtractedAttendantFields {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
      return {};
    }
    const fields = (metadata as Record<string, unknown>).extractedFields;
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
      return {};
    }
    return fields as ExtractedAttendantFields;
  }

  private resolveActionStatus(
    intent: AttendantIntent,
    missingFields: string[],
  ): AttendantActionStatus {
    if (!this.isLeadIntent(intent)) {
      return 'NEEDS_INFO';
    }
    if (intent === 'HUMAN_HANDOFF') {
      return 'NEEDS_HUMAN';
    }
    return missingFields.length ? 'NEEDS_INFO' : 'PENDING_CONFIRMATION';
  }

  private resolveNextInstruction(input: {
    actionCreated: boolean;
    actionStatus: AttendantActionStatus;
    missingFields: string[];
    intent: AttendantIntent;
  }) {
    if (input.actionCreated) {
      if (input.intent === 'CUSTOMER_DATA_CAPTURE') {
        return 'acknowledge_customer_data_saved';
      }
      return 'confirm_registered_pending_team_confirmation';
    }
    if (input.missingFields.includes('customerName') || input.missingFields.includes('phone')) {
      return 'ask_for_name_and_phone';
    }
    if (input.missingFields.includes('requestedService')) {
      return 'ask_for_service_or_objective';
    }
    if (input.missingFields.includes('desiredDate') || input.missingFields.includes('desiredTime')) {
      return 'ask_for_date_and_time';
    }
    if (input.intent === 'GENERAL_QUESTION') {
      return 'answer_normally';
    }
    return 'continue_conversation';
  }

  private isLeadIntent(intent?: AttendantIntent | null) {
    return Boolean(intent && LEAD_INTENTS.includes(intent));
  }

  private hasCustomerMinimum(fields: ExtractedAttendantFields) {
    return Boolean(fields.customerName && (fields.phone || fields.email));
  }

  private hasActionMinimum(intent: AttendantIntent, fields: ExtractedAttendantFields) {
    if (!this.isLeadIntent(intent)) {
      return false;
    }
    const hasInterest = Boolean(fields.requestedService || fields.objective);
    if (!hasInterest && intent !== 'CUSTOMER_DATA_CAPTURE' && intent !== 'HUMAN_HANDOFF') {
      return false;
    }
    if (intent === 'CUSTOMER_DATA_CAPTURE') {
      return false;
    }
    if (['SCHEDULE_REQUEST', 'MEETING_REQUEST'].includes(intent)) {
      return Boolean(fields.desiredDate && fields.desiredTime && hasInterest);
    }
    return true;
  }

  private async findExistingCustomer(
    input: AttendantActionInput,
    fields: ExtractedAttendantFields,
  ) {
    if (fields.phone) {
      return this.prisma.customer.findFirst({
        where: { companyId: input.companyId, phone: fields.phone },
        select: { id: true },
      });
    }

    if (fields.email) {
      return this.prisma.customer.findFirst({
        where: { companyId: input.companyId, email: fields.email },
        select: { id: true },
      });
    }

    return this.prisma.customer.findFirst({
      where: {
        companyId: input.companyId,
        externalCustomerId: input.customerExternalId,
        channel: input.channel,
        provider: input.provider,
      },
      select: { id: true },
    });
  }

  private startsNewActionSession(intent: AttendantIntent, text: string) {
    if (!['SCHEDULE_REQUEST', 'MEETING_REQUEST', 'SERVICE_REQUEST', 'QUOTE_REQUEST', 'PRODUCT_INTEREST'].includes(intent)) {
      return false;
    }
    const normalized = this.normalize(text);
    return [
      'quero marcar',
      'gostaria de marcar',
      'preciso marcar',
      'quero agendar',
      'gostaria de agendar',
      'quero uma consulta',
      'quero consulta',
      'quero uma avaliacao',
      'quero avaliacao',
      'quero orcamento',
      'gostaria de um orcamento',
      'quero uma reuniao',
      'quero atendimento',
      'tenho interesse',
      'quero reservar',
    ].some((term) => normalized.includes(term));
  }

  private looksLikeCustomerUpdate(text: string, fields: ExtractedAttendantFields) {
    if (fields.customerName || fields.phone || fields.email) {
      return true;
    }
    return Boolean(this.extractStandaloneName(text));
  }

  private pickBestName(existing?: string | null, current?: string | null) {
    if (!current) {
      return existing || null;
    }
    if (!existing) {
      return current;
    }
    return current.trim().split(/\s+/).length >= existing.trim().split(/\s+/).length
      ? current
      : existing;
  }

  private scoreIntent(intent: AttendantIntent) {
    if (['SCHEDULE_REQUEST', 'MEETING_REQUEST', 'QUOTE_REQUEST', 'PRODUCT_INTEREST'].includes(intent)) {
      return 85;
    }
    if (intent === 'SERVICE_REQUEST') {
      return 75;
    }
    if (intent === 'CUSTOMER_DATA_CAPTURE') {
      return 60;
    }
    return 30;
  }

  private buildMetadata(
    input: AttendantActionInput,
    intent: AttendantIntent,
    fields: ExtractedAttendantFields,
    ownerNote?: string | null,
  ) {
    return {
      source: 'attendant_action_layer',
      channel: input.channel,
      provider: input.provider,
      customerExternalId: input.customerExternalId,
      businessAccountId: input.businessAccountId || null,
      sourceMessageId: input.sourceMessageId || null,
      intent,
      extractedFields: fields,
      ownerNote: ownerNote || null,
    };
  }

  private async customerAppearsInCustomers(companyId: string, customerId: string) {
    const customer = await this.prisma.customer.findFirst({
      where: { id: customerId, companyId },
      select: { id: true },
    });
    const visible = Boolean(customer?.id);
    this.logger.log(
      JSON.stringify({
        event: 'customers.visibility.check',
        companyId,
        customerId,
        visible,
      }),
    );
    return visible;
  }

  private buildOwnerNote(input: AttendantActionInput, fields: ExtractedAttendantFields) {
    const timestamp = new Date().toLocaleString('pt-BR', {
      timeZone: 'America/Sao_Paulo',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
    const interest = fields.requestedService || fields.objective || 'nao informado';
    const desiredDate = fields.desiredDate ? this.formatDateOnly(fields.desiredDate) : null;
    const dateTime = [desiredDate, fields.desiredTime].filter(Boolean).join(' as ');
    const origin = input.channel === 'instagram' ? 'Instagram' : input.channel === 'whatsapp' ? 'WhatsApp' : input.channel;
    return [
      `Atendimento realizado em ${timestamp}.`,
      `Origem: ${origin}.`,
      `Interesse: ${interest}.`,
      dateTime ? `Data/hora desejada: ${dateTime}.` : null,
      'Status: Aguardando confirmacao.',
      'Confirmar com o cliente e assumir o atendimento.',
    ]
      .filter(Boolean)
      .join(' ');
  }

  private extractStandaloneName(text: string) {
    const compact = text.replace(/\s+/g, ' ').trim();
    const withoutPhone = compact.replace(/(?:\+?55\s?)?(?:\(?\d{2}\)?\s?)?\d{4,5}[-\s]?\d{4}/g, '').trim();
    if (!withoutPhone || /[0-9@]/.test(withoutPhone)) {
      return null;
    }
    const normalized = this.normalize(withoutPhone);
    if (/(quero|consulta|avaliacao|amanha|hoje|horario|marcar|agendar|telefone|email)/.test(normalized)) {
      return null;
    }
    const words = withoutPhone.split(/\s+/).filter(Boolean);
    return words.length >= 2 && words.length <= 6 ? withoutPhone : null;
  }

  private parseDate(value?: string | null) {
    if (!value) {
      return null;
    }
    const date = new Date(`${value}T12:00:00.000Z`);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  private formatDateOnly(value: string) {
    const [year, month, day] = value.split('-');
    return year && month && day ? `${day}/${month}/${year}` : value;
  }

  private normalize(text: string) {
    return text
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
  }

  private toJson(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value ?? {})) as Prisma.InputJsonValue;
  }
}
