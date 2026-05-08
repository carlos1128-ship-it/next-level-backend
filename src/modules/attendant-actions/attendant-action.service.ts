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
    const existingDraft = input.conversationId
      ? await this.findOpenActionDraft(input.companyId, input.conversationId)
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
    const actionStatus = this.resolveActionStatus(effectiveIntent, missingFields);
    const companyContext = await this.contextService.buildCompanyActionContext(input.companyId);
    const leadIntent = this.isLeadIntent(effectiveIntent);
    const shouldCreateCustomer = leadIntent && this.hasCustomerMinimum(extractedFields);
    const shouldCreateActionRequest =
      shouldCreateCustomer && this.hasActionMinimum(effectiveIntent, extractedFields);

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
      });
    }

    const shouldSaveActionDraft =
      Boolean(input.conversationId) &&
      (effectiveIntent !== 'CUSTOMER_DATA_CAPTURE' || Boolean(existingDraft));
    let customer: { id: string } | null = null;
    let lead: { id: string } | null = null;

    if (shouldCreateCustomer) {
      customer = await this.upsertCustomer(input, effectiveIntent, actionStatus, extractedFields);
      lead = await this.upsertLead(input, effectiveIntent, actionStatus, extractedFields);
    }

    const request = shouldSaveActionDraft
      ? await this.upsertBusinessActionRequest({
          input,
          existingId: existingDraft?.id || null,
          intent: effectiveIntent,
          status: actionStatus,
          fields: extractedFields,
          customerId: customer?.id || null,
          leadId: lead?.id || null,
        })
      : null;

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
        missingFields,
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
      actionCreated: Boolean(
        customer?.id &&
          (shouldCreateActionRequest || effectiveIntent === 'CUSTOMER_DATA_CAPTURE'),
      ),
      draftSaved: Boolean(request?.id),
      customerId: customer?.id || null,
      leadId: lead?.id || null,
      businessActionRequestId: request?.id || null,
    });
  }

  async preview(input: AttendantActionInput) {
    return this.analyzeAndPrepare({ ...input, dryRun: true });
  }

  private async findOpenActionDraft(companyId: string, conversationId: string) {
    return this.prisma.businessActionRequest.findFirst({
      where: {
        companyId,
        conversationId,
        status: { in: ['NEEDS_INFO', 'PENDING_CONFIRMATION'] },
      },
      orderBy: { updatedAt: 'desc' },
      select: { id: true, type: true, metadata: true },
    });
  }

  private async upsertCustomer(
    input: AttendantActionInput,
    intent: AttendantIntent,
    actionStatus: AttendantActionStatus,
    fields: ExtractedAttendantFields,
  ) {
    const existing = await this.prisma.customer.findFirst({
      where: {
        companyId: input.companyId,
        OR: [
          fields.phone ? { phone: fields.phone } : undefined,
          fields.email ? { email: fields.email } : undefined,
          { externalCustomerId: input.customerExternalId },
        ].filter(Boolean) as Prisma.CustomerWhereInput[],
      },
      select: { id: true },
    });
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
      objective: fields.objective || fields.notes || undefined,
      desiredDate: this.parseDate(fields.desiredDate) || undefined,
      desiredTime: fields.desiredTime || undefined,
      status: actionStatus,
      metadata: this.toJson(this.buildMetadata(input, intent, fields)),
    };

    if (existing) {
      return this.prisma.customer.update({
        where: { id: existing.id },
        data,
        select: { id: true },
      });
    }

    return this.prisma.customer.create({
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
  }

  private async upsertLead(
    input: AttendantActionInput,
    intent: AttendantIntent,
    actionStatus: AttendantActionStatus,
    fields: ExtractedAttendantFields,
  ) {
    const externalId = `${input.channel}:${input.customerExternalId}`;
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
        notes: fields.notes || undefined,
        metadata: this.toJson(this.buildMetadata(input, intent, fields)),
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
        notes: fields.notes || null,
        metadata: this.toJson(this.buildMetadata(input, intent, fields)),
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
      notes: input.fields.notes || undefined,
      metadata: this.toJson(this.buildMetadata(input.input, input.intent, input.fields)),
    };

    if (input.existingId) {
      return this.prisma.businessActionRequest.update({
        where: { id: input.existingId },
        data,
        select: { id: true },
      });
    }

    return this.prisma.businessActionRequest.create({
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
        notes: input.fields.notes || null,
        metadata: data.metadata,
      },
      select: { id: true },
    });
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
  }): AttendantActionAnalysis {
    const nextAssistantInstruction = this.resolveNextInstruction(input);
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
      nextAssistantInstruction,
      promptContext: this.buildPromptContext({ ...input, nextAssistantInstruction }),
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
      input.actionCreated
        ? `Cliente/lead e BusinessActionRequest salvos. ID: ${input.businessActionRequestId || 'salvo'}.`
        : input.draftSaved
          ? 'Rascunho interno atualizado; ainda nao diga que a solicitacao foi registrada, peca os dados faltantes.'
          : 'Nenhuma acao estruturada salva para esta mensagem.',
      `Proxima instrucao: ${input.nextAssistantInstruction}.`,
      input.companyContext,
      'Regra obrigatoria: nao diga que esta confirmado sem disponibilidade real. Se todos os dados foram salvos, diga que foi registrado para confirmacao da equipe.',
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
      customerName: current.customerName || existing.customerName || null,
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
    };
  }

  private parseDate(value?: string | null) {
    if (!value) {
      return null;
    }
    const date = new Date(`${value}T12:00:00.000Z`);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  private toJson(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value ?? {})) as Prisma.InputJsonValue;
  }
}
