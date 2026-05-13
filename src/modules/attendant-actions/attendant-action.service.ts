import { Injectable, Logger } from '@nestjs/common';
import {
  FinancialTransactionType,
  Prisma,
  SaleAIAttributionSource,
  SaleChannel,
} from '@prisma/client';
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
  'ORDER_PLACED',
  'SALE_COMPLETED',
  'SUBSCRIPTION_CLOSED',
  'PAYMENT_INTENTION',
  'SUPPORT_REQUEST',
  'CANCELLATION_REQUEST',
  'UPSELL_RENEWAL_OPPORTUNITY',
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
    const currentFields = this.applyIdentityFallback(
      this.extractionService.extract(input.text),
      input,
    );
    const userConfirmed = this.isConfirmationOnly(input.text);
    if (userConfirmed) {
      this.logger.log(
        JSON.stringify({
          event: 'attendant.action.confirmation_detected',
          companyId: input.companyId,
          channel: input.channel,
          provider: input.provider,
        }),
      );
    }
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
    const shouldCreateCustomer = leadIntent && this.hasCustomerMinimum(input, extractedFields);
    const shouldCreateActionRequest =
      shouldCreateCustomer && this.hasActionMinimum(effectiveIntent, extractedFields);
    let appearsInCustomers = false;

    if (input.dryRun || !leadIntent) {
      return this.buildAnalysis({
        companyId: input.companyId,
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

    const appointmentRequest = await this.maybeUpsertAppointmentRequest({
      input,
      intent: effectiveIntent,
      status: actionStatus,
      fields: extractedFields,
      leadId: lead?.id || null,
    });

    const commercialRecord = await this.maybeUpsertCommercialRecord({
      input,
      intent: effectiveIntent,
      fields: extractedFields,
      customerId: customer?.id || null,
      leadId: lead?.id || null,
    });

    await this.persistActionSignals({
      input,
      intent: effectiveIntent,
      status: actionStatus,
      fields: extractedFields,
      customerId: customer?.id || null,
      leadId: lead?.id || null,
      appointmentRequestId: appointmentRequest?.id || null,
      saleId: commercialRecord?.saleId || null,
      financialTransactionId: commercialRecord?.financialTransactionId || null,
    });

    const actionCreated = Boolean(
      customer?.id &&
        appearsInCustomers &&
        (shouldCreateActionRequest ||
          effectiveIntent === 'CUSTOMER_DATA_CAPTURE' ||
          appointmentRequest?.id ||
          commercialRecord?.saleId),
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
        appointmentRequestId: appointmentRequest?.id || null,
        saleId: commercialRecord?.saleId || null,
        financialTransactionId: commercialRecord?.financialTransactionId || null,
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
      companyId: input.companyId,
      intent: effectiveIntent,
      extractedFields,
      missingFields,
      actionStatus,
      companyContext,
      shouldCreateCustomer,
      shouldCreateActionRequest,
      actionCreated,
      draftSaved: Boolean(request?.id),
      userConfirmed,
      justSaved: Boolean(
        actionCreated &&
          (request?.operation === 'created' || existingDraft?.status !== 'PENDING_CONFIRMATION'),
      ),
      customerId: customer?.id || null,
      leadId: lead?.id || null,
      businessActionRequestId: request?.id || null,
      appointmentRequestId: appointmentRequest?.id || null,
      saleId: commercialRecord?.saleId || null,
      financialTransactionId: commercialRecord?.financialTransactionId || null,
      customerCreatedOrUpdated: Boolean(customer?.id),
      customerCreated: customer?.operation === 'created',
      customerUpdated: customer?.operation === 'updated',
      leadCreatedOrUpdated: Boolean(lead?.id),
      saleCreatedOrUpdated: Boolean(commercialRecord?.saleId),
      financialTransactionCreatedOrUpdated: Boolean(
        commercialRecord?.financialTransactionId,
      ),
      appointmentRequestCreatedOrUpdated: Boolean(appointmentRequest?.id),
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

    const userConfirmed = this.isConfirmationOnly(input.text);

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

    if (!this.looksLikeCustomerUpdate(input.text, currentFields) && !userConfirmed) {
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

  private async maybeUpsertAppointmentRequest(input: {
    input: AttendantActionInput;
    intent: AttendantIntent;
    status: AttendantActionStatus;
    fields: ExtractedAttendantFields;
    leadId?: string | null;
  }) {
    if (!['SCHEDULE_REQUEST', 'MEETING_REQUEST'].includes(input.intent)) {
      return null;
    }
    if (!input.input.conversationId) {
      return null;
    }

    const payload = {
      leadId: input.leadId || undefined,
      channel: input.input.channel,
      provider: input.input.provider,
      customerExternalId: input.input.customerExternalId,
      customerName: input.fields.customerName || undefined,
      phone: input.fields.phone || undefined,
      email: input.fields.email || undefined,
      intent: input.intent,
      status: input.status,
      requestedService:
        input.fields.requestedService || input.fields.objective || undefined,
      requestedDate: this.parseDate(input.fields.desiredDate) || undefined,
      requestedTime: input.fields.desiredTime || undefined,
      notes: this.buildOwnerNote(input.input, input.fields),
      sourceMessageId: input.input.sourceMessageId || undefined,
      metadata: this.toJson(
        this.buildMetadata(input.input, input.intent, input.fields),
      ),
    };

    const existing = await this.prisma.appointmentRequest.findFirst({
      where: {
        companyId: input.input.companyId,
        conversationId: input.input.conversationId,
        OR: [
          ...(input.input.sourceMessageId
            ? [{ sourceMessageId: input.input.sourceMessageId }]
            : []),
          {
            customerExternalId: input.input.customerExternalId,
            intent: input.intent,
            requestedDate: this.parseDate(input.fields.desiredDate) || undefined,
            requestedTime: input.fields.desiredTime || undefined,
          },
        ],
      },
      select: { id: true },
    });

    if (existing) {
      const updated = await this.prisma.appointmentRequest.update({
        where: { id: existing.id },
        data: payload,
        select: { id: true },
      });
      return { id: updated.id, operation: 'updated' as const };
    }

    const created = await this.prisma.appointmentRequest.create({
      data: {
        companyId: input.input.companyId,
        conversationId: input.input.conversationId,
        ...payload,
        leadId: input.leadId || null,
        customerName: input.fields.customerName || null,
        phone: input.fields.phone || null,
        email: input.fields.email || null,
        requestedService:
          input.fields.requestedService || input.fields.objective || null,
        requestedDate: this.parseDate(input.fields.desiredDate),
        requestedTime: input.fields.desiredTime || null,
        sourceMessageId: input.input.sourceMessageId || null,
      },
      select: { id: true },
    });
    return { id: created.id, operation: 'created' as const };
  }

  private async maybeUpsertCommercialRecord(input: {
    input: AttendantActionInput;
    intent: AttendantIntent;
    fields: ExtractedAttendantFields;
    customerId?: string | null;
    leadId?: string | null;
  }) {
    if (!['SALE_COMPLETED', 'SUBSCRIPTION_CLOSED'].includes(input.intent)) {
      return null;
    }
    const amount = input.fields.amount || 0;
    if (!amount || amount <= 0) {
      return null;
    }

    const externalId = this.buildExternalEventId(input.input, input.intent, input.fields);
    const occurredAt = new Date();
    const productName =
      input.fields.productName ||
      input.fields.requestedService ||
      input.fields.objective ||
      (input.intent === 'SUBSCRIPTION_CLOSED' ? 'Assinatura' : 'Venda via atendimento');
    const source = input.input.channel === 'instagram' ? 'instagram' : 'whatsapp';
    const sale = await this.prisma.sale.upsert({
      where: {
        companyId_channel_externalId: {
          companyId: input.input.companyId,
          channel: SaleChannel.meta,
          externalId,
        },
      },
      update: {
        amount: new Prisma.Decimal(amount),
        productName,
        category: source.toUpperCase(),
        metadataJson: this.toJson({
          source,
          provider: input.input.provider,
          intent: input.intent,
          customerId: input.customerId || null,
          leadId: input.leadId || null,
          fields: input.fields,
        }),
        occurredAt,
      },
      create: {
        companyId: input.input.companyId,
        amount: new Prisma.Decimal(amount),
        productName,
        category: source.toUpperCase(),
        channel: SaleChannel.meta,
        externalId,
        metadataJson: this.toJson({
          source,
          provider: input.input.provider,
          intent: input.intent,
          customerId: input.customerId || null,
          leadId: input.leadId || null,
          fields: input.fields,
        }),
        occurredAt,
      },
      select: { id: true },
    });

    const transaction = await this.prisma.financialTransaction.upsert({
      where: {
        companyId_source_externalId: {
          companyId: input.input.companyId,
          source,
          externalId,
        },
      },
      update: {
        amount: new Prisma.Decimal(amount),
        description: `Receita ${source}: ${productName}`,
        category: source.toUpperCase(),
        metadataJson: this.toJson({
          saleId: sale.id,
          intent: input.intent,
          customerId: input.customerId || null,
          leadId: input.leadId || null,
          fields: input.fields,
        }),
        date: occurredAt,
        occurredAt,
      },
      create: {
        companyId: input.input.companyId,
        type: FinancialTransactionType.INCOME,
        amount: new Prisma.Decimal(amount),
        description: `Receita ${source}: ${productName}`,
        category: source.toUpperCase(),
        source,
        externalId,
        metadataJson: this.toJson({
          saleId: sale.id,
          intent: input.intent,
          customerId: input.customerId || null,
          leadId: input.leadId || null,
          fields: input.fields,
        }),
        date: occurredAt,
        occurredAt,
      },
      select: { id: true },
    });

    await this.prisma.saleAIAttribution.upsert({
      where: { saleId: sale.id },
      update: {
        companyId: input.input.companyId,
        conversationId: input.input.conversationId || undefined,
        leadId: input.leadId || undefined,
        source:
          source === 'instagram'
            ? SaleAIAttributionSource.INSTAGRAM_AGENT
            : SaleAIAttributionSource.WHATSAPP_AGENT,
        attributedRevenue: new Prisma.Decimal(amount),
        confidence: 0.9,
        metadataJson: this.toJson({
          source,
          provider: input.input.provider,
          sourceMessageId: input.input.sourceMessageId || null,
          intent: input.intent,
        }),
        occurredAt,
      },
      create: {
        companyId: input.input.companyId,
        saleId: sale.id,
        conversationId: input.input.conversationId || null,
        leadId: input.leadId || null,
        source:
          source === 'instagram'
            ? SaleAIAttributionSource.INSTAGRAM_AGENT
            : SaleAIAttributionSource.WHATSAPP_AGENT,
        attributedRevenue: new Prisma.Decimal(amount),
        confidence: 0.9,
        metadataJson: this.toJson({
          source,
          provider: input.input.provider,
          sourceMessageId: input.input.sourceMessageId || null,
          intent: input.intent,
        }),
        occurredAt,
      },
    });

    return { saleId: sale.id, financialTransactionId: transaction.id };
  }

  private async persistActionSignals(input: {
    input: AttendantActionInput;
    intent: AttendantIntent;
    status: AttendantActionStatus;
    fields: ExtractedAttendantFields;
    customerId?: string | null;
    leadId?: string | null;
    appointmentRequestId?: string | null;
    saleId?: string | null;
    financialTransactionId?: string | null;
  }) {
    const source = input.input.channel === 'instagram' ? 'instagram_agent' : 'whatsapp_agent';
    const description = this.describeSignal(input.intent, input.fields);
    const metadata = this.toJson({
      channel: input.input.channel,
      provider: input.input.provider,
      status: input.status,
      sourceMessageId: input.input.sourceMessageId || null,
      customerId: input.customerId || null,
      leadId: input.leadId || null,
      appointmentRequestId: input.appointmentRequestId || null,
      saleId: input.saleId || null,
      financialTransactionId: input.financialTransactionId || null,
      fields: input.fields,
    });

    if (input.customerId || input.leadId || input.saleId || input.appointmentRequestId) {
      await this.prisma.customerSignal.create({
        data: {
          companyId: input.input.companyId,
          customerId: input.customerId || null,
          source,
          signalType: input.intent,
          description,
          metadataJson: metadata,
        },
      });
    }

    if (input.saleId || input.appointmentRequestId || input.intent === 'HUMAN_HANDOFF') {
      await this.prisma.businessEvent.create({
        data: {
          companyId: input.input.companyId,
          source,
          type: input.intent,
          title: this.eventTitle(input.intent),
          description,
          metadataJson: metadata,
          occurredAt: new Date(),
        },
      });
    }

    await this.prisma.businessMemory.upsert({
      where: {
        companyId_key: {
          companyId: input.input.companyId,
          key: `social:${input.input.channel}:${input.input.sourceMessageId || input.input.conversationId || input.intent}`,
        },
      },
      update: {
        value: description,
        category: 'social_automation',
        confidence: input.saleId || input.appointmentRequestId ? 0.9 : 0.7,
        metadataJson: metadata,
      },
      create: {
        companyId: input.input.companyId,
        key: `social:${input.input.channel}:${input.input.sourceMessageId || input.input.conversationId || input.intent}`,
        value: description,
        category: 'social_automation',
        confidence: input.saleId || input.appointmentRequestId ? 0.9 : 0.7,
        metadataJson: metadata,
      },
    });
  }

  private buildExternalEventId(
    input: AttendantActionInput,
    intent: AttendantIntent,
    fields: ExtractedAttendantFields,
  ) {
    const explicit = fields.externalOrderId || input.sourceMessageId;
    if (explicit) {
      return `${input.channel}:${explicit}`;
    }
    const fingerprint = [
      input.conversationId || input.customerExternalId,
      intent,
      fields.amount || 0,
      fields.productName || fields.requestedService || fields.objective || 'sem-produto',
    ]
      .join(':')
      .toLowerCase()
      .replace(/[^a-z0-9:._-]+/g, '-')
      .slice(0, 180);
    return `${input.channel}:${fingerprint}`;
  }

  private describeSignal(intent: AttendantIntent, fields: ExtractedAttendantFields) {
    const product =
      fields.productName || fields.requestedService || fields.objective || 'interesse nao especificado';
    const amount = fields.amount ? ` Valor: R$ ${fields.amount.toFixed(2)}.` : '';
    const schedule = [fields.desiredDate, fields.desiredTime].filter(Boolean).join(' as ');
    const scheduleText = schedule ? ` Agenda solicitada: ${schedule}.` : '';
    return `${this.eventTitle(intent)} detectado em atendimento. Item: ${product}.${amount}${scheduleText}`.trim();
  }

  private eventTitle(intent: AttendantIntent) {
    const titles: Partial<Record<AttendantIntent, string>> = {
      SALE_COMPLETED: 'Venda concluida',
      SUBSCRIPTION_CLOSED: 'Assinatura fechada',
      ORDER_PLACED: 'Pedido solicitado',
      PAYMENT_INTENTION: 'Intencao de pagamento',
      SCHEDULE_REQUEST: 'Agendamento solicitado',
      MEETING_REQUEST: 'Reuniao solicitada',
      SUPPORT_REQUEST: 'Suporte solicitado',
      HUMAN_HANDOFF: 'Atendimento humano solicitado',
      CANCELLATION_REQUEST: 'Cancelamento solicitado',
      UPSELL_RENEWAL_OPPORTUNITY: 'Oportunidade de upsell ou renovacao',
      PRODUCT_INTEREST: 'Interesse comercial',
      QUOTE_REQUEST: 'Orcamento solicitado',
      SERVICE_REQUEST: 'Servico solicitado',
      CUSTOMER_DATA_CAPTURE: 'Dados de cliente capturados',
      SERVICE_INFORMATION: 'Pedido de informacao',
    };
    return titles[intent] || 'Sinal de atendimento';
  }

  private buildAnalysis(input: {
    companyId: string;
    intent: AttendantIntent;
    extractedFields: ExtractedAttendantFields;
    missingFields: string[];
    actionStatus: AttendantActionStatus;
    companyContext: string;
    shouldCreateCustomer: boolean;
    shouldCreateActionRequest: boolean;
    actionCreated: boolean;
    draftSaved: boolean;
    userConfirmed?: boolean;
    justSaved?: boolean;
    customerId?: string | null;
    leadId?: string | null;
    appointmentRequestId?: string | null;
    saleId?: string | null;
    financialTransactionId?: string | null;
    businessActionRequestId?: string | null;
    customerCreatedOrUpdated?: boolean;
    customerCreated?: boolean;
    customerUpdated?: boolean;
    leadCreatedOrUpdated?: boolean;
    saleCreatedOrUpdated?: boolean;
    financialTransactionCreatedOrUpdated?: boolean;
    appointmentRequestCreatedOrUpdated?: boolean;
    businessActionRequestCreatedOrUpdated?: boolean;
    businessActionRequestCreated?: boolean;
    appearsInCustomers?: boolean;
  }): AttendantActionAnalysis {
    const nextAssistantInstruction = this.resolveNextInstruction(input);
    const registrationClaimAllowed = Boolean(input.actionCreated && input.appearsInCustomers);
    const isComplete = input.missingFields.length === 0 && input.actionStatus === 'PENDING_CONFIRMATION';
    const shouldFinalize = Boolean(registrationClaimAllowed && isComplete);
    const shouldAskConfirmation = this.shouldAskConfirmation(input);
    if (shouldFinalize) {
      this.logger.log(
        JSON.stringify({
          event: 'attendant.action.completion_ready',
          companyId: input.companyId,
          intent: input.intent,
          actionStatus: input.actionStatus,
          registrationClaimAllowed,
          justSaved: Boolean(input.justSaved),
        }),
      );
      this.logger.log(
        JSON.stringify({
          event: 'attendant.action.finalized',
          companyId: input.companyId,
          intent: input.intent,
          businessActionRequestId: input.businessActionRequestId || null,
        }),
      );
      if (input.userConfirmed) {
        this.logger.log(
          JSON.stringify({
            event: 'attendant.action.extra_confirmation_skipped',
            companyId: input.companyId,
            intent: input.intent,
            businessActionRequestId: input.businessActionRequestId || null,
          }),
        );
      }
    }
    return {
      intent: input.intent,
      extractedFields: input.extractedFields,
      missingFields: input.missingFields,
      actionStatus: input.actionStatus,
      shouldCreateCustomer: input.shouldCreateCustomer,
      shouldCreateActionRequest: input.shouldCreateActionRequest,
      customerId: input.customerId || null,
      leadId: input.leadId || null,
      appointmentRequestId: input.appointmentRequestId || null,
      saleId: input.saleId || null,
      financialTransactionId: input.financialTransactionId || null,
      businessActionRequestId: input.businessActionRequestId || null,
      actionCreated: input.actionCreated,
      draftSaved: input.draftSaved,
      customerCreatedOrUpdated: Boolean(input.customerCreatedOrUpdated),
      customerCreated: Boolean(input.customerCreated),
      customerUpdated: Boolean(input.customerUpdated),
      leadCreatedOrUpdated: Boolean(input.leadCreatedOrUpdated),
      saleCreatedOrUpdated: Boolean(input.saleCreatedOrUpdated),
      financialTransactionCreatedOrUpdated: Boolean(
        input.financialTransactionCreatedOrUpdated,
      ),
      appointmentRequestCreatedOrUpdated: Boolean(
        input.appointmentRequestCreatedOrUpdated,
      ),
      businessActionRequestCreatedOrUpdated: Boolean(
        input.businessActionRequestCreatedOrUpdated,
      ),
      businessActionRequestCreated: Boolean(input.businessActionRequestCreated),
      appearsInCustomers: Boolean(input.appearsInCustomers),
      registrationClaimAllowed,
      isComplete,
      justSaved: Boolean(input.justSaved),
      userConfirmed: Boolean(input.userConfirmed),
      shouldAskConfirmation,
      shouldFinalize,
      ok: true,
      errorClassification: null,
      shouldContinueAiResponse: true,
      shouldAskMissingFields: input.missingFields.length > 0,
      shouldHumanHandoff: input.intent === 'HUMAN_HANDOFF',
      assistantInstruction: shouldFinalize ? 'finalize_registered_request' : nextAssistantInstruction,
      nextAssistantInstruction: shouldFinalize ? 'finalize_registered_request' : nextAssistantInstruction,
      promptContext: this.buildPromptContext({
        ...input,
        registrationClaimAllowed,
        nextAssistantInstruction: shouldFinalize
          ? 'finalize_registered_request'
          : nextAssistantInstruction,
        isComplete,
        shouldAskConfirmation,
        shouldFinalize,
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
    isComplete?: boolean;
    shouldAskConfirmation?: boolean;
    shouldFinalize?: boolean;
  }) {
    return [
      'Camada de acao generica do Atendente IA:',
      `Intent detectada: ${input.intent}.`,
      `Campos acumulados na conversa: ${JSON.stringify(input.extractedFields)}.`,
      `Campos faltantes: ${input.missingFields.length ? input.missingFields.join(', ') : 'nenhum'}.`,
      `Status da acao: ${input.actionStatus}.`,
      `Cliente pode ser salvo agora: ${input.shouldCreateCustomer}.`,
      `Pedido/acao pode ser salvo agora: ${input.shouldCreateActionRequest}.`,
      `Acao completa: ${Boolean(input.isComplete)}.`,
      `Deve pedir confirmacao extra: ${Boolean(input.shouldAskConfirmation)}.`,
      `Deve finalizar agora: ${Boolean(input.shouldFinalize)}.`,
      input.registrationClaimAllowed
        ? `Cliente/lead e BusinessActionRequest salvos. ID: ${input.businessActionRequestId || 'salvo'}.`
        : input.draftSaved
          ? 'Rascunho interno atualizado; ainda nao diga que a solicitacao foi registrada, peca os dados faltantes.'
          : 'Nenhuma acao estruturada salva para esta mensagem.',
      `Pode afirmar que registrou a solicitacao: ${input.registrationClaimAllowed}.`,
      `Proxima instrucao: ${input.nextAssistantInstruction}.`,
      input.companyContext,
      'Regra obrigatoria: nao diga que esta confirmado sem disponibilidade real. So diga que registrou se "Pode afirmar que registrou a solicitacao" for true. Se for false, peca apenas os dados faltantes. Nao diga que vai chamar humano em fluxo normal; diga que a equipe vai confirmar o horario.',
      'Regra anti-loop: nao peca confirmacao de dados explicitos. Se "Deve finalizar agora" for true, conclua em uma frase curta e nao pergunte de novo.',
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
      amount: current.amount || existing.amount || null,
      productName: current.productName || existing.productName || null,
      quantity: current.quantity || existing.quantity || null,
      externalOrderId: current.externalOrderId || existing.externalOrderId || null,
      notes: [existing.notes, current.notes].filter(Boolean).join(' | ') || null,
    };
  }

  private applyIdentityFallback(
    fields: ExtractedAttendantFields,
    input: AttendantActionInput,
  ): ExtractedAttendantFields {
    const channelLabel = input.channel === 'instagram' ? 'Instagram' : 'WhatsApp';
    return {
      ...fields,
      customerName:
        fields.customerName ||
        input.customerName ||
        (input.customerExternalId ? `Cliente ${channelLabel}` : null),
      phone: fields.phone || input.customerPhone || null,
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

  private shouldAskConfirmation(input: {
    actionStatus: AttendantActionStatus;
    missingFields: string[];
    actionCreated: boolean;
  }) {
    if (input.actionCreated && input.actionStatus === 'PENDING_CONFIRMATION') {
      return false;
    }
    return input.missingFields.includes('desiredDate') || input.missingFields.includes('desiredTime');
  }

  private isConfirmationOnly(text: string) {
    const normalized = this.normalize(text).replace(/[.!?]+/g, '').trim();
    return [
      'sim',
      'correto',
      'isso',
      'exatamente',
      'pode ser',
      'confirmo',
      'esta certo',
      'ta certo',
      'certo',
      'perfeito',
      'ok',
      'okay',
    ].includes(normalized);
  }

  private isLeadIntent(intent?: AttendantIntent | null) {
    return Boolean(intent && LEAD_INTENTS.includes(intent));
  }

  private hasCustomerMinimum(input: AttendantActionInput, fields: ExtractedAttendantFields) {
    return Boolean(
      fields.customerName &&
        (fields.phone || fields.email || input.customerExternalId),
    );
  }

  private hasActionMinimum(intent: AttendantIntent, fields: ExtractedAttendantFields) {
    if (!this.isLeadIntent(intent)) {
      return false;
    }
    if (
      [
        'SUPPORT_REQUEST',
        'CANCELLATION_REQUEST',
        'PAYMENT_INTENTION',
        'UPSELL_RENEWAL_OPPORTUNITY',
        'HUMAN_HANDOFF',
      ].includes(intent)
    ) {
      return true;
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
    if (['SALE_COMPLETED', 'SUBSCRIPTION_CLOSED'].includes(intent)) {
      return Boolean(fields.amount && fields.amount > 0);
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

    if (input.channel === 'whatsapp' && input.customerExternalId) {
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
