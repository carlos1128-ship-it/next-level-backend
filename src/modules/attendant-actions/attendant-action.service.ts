import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  AppointmentRequestStatus,
  AttendantActionAnalysis,
  AttendantActionInput,
  AttendantActionStatus,
  AttendantIntent,
  ExtractedAttendantFields,
} from './attendant-action.types';
import { AttendantContextService } from './attendant-context.service';
import { AttendantDataExtractionService } from './attendant-data-extraction.service';
import { AttendantIntentService } from './attendant-intent.service';

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
    const intent = this.intentService.detectIntent(input.text);
    const extractedFields = this.extractionService.extract(input.text);
    const missingFields =
      intent === 'SCHEDULE_REQUEST'
        ? this.extractionService.missingForSchedule(extractedFields)
        : [];
    const actionStatus = this.resolveActionStatus(intent, missingFields);
    const companyContext = await this.contextService.buildCompanyActionContext(input.companyId);

    if (input.dryRun || !this.shouldPersist(intent)) {
      return this.buildAnalysis({
        intent,
        extractedFields,
        missingFields,
        actionStatus,
        companyContext,
        actionCreated: false,
      });
    }

    const lead = await this.upsertLead(input, intent, actionStatus, extractedFields);
    const request =
      intent === 'SCHEDULE_REQUEST'
        ? await this.upsertAppointmentRequest(
            input,
            lead.id,
            intent,
            this.toAppointmentStatus(actionStatus),
            extractedFields,
          )
        : null;

    this.logger.log(
      JSON.stringify({
        event: 'attendant.action.detected',
        companyId: input.companyId,
        channel: input.channel,
        provider: input.provider,
        intent,
        actionStatus,
        leadCreatedOrUpdated: Boolean(lead.id),
        appointmentRequestId: request?.id || null,
        missingFields,
      }),
    );

    return this.buildAnalysis({
      intent,
      extractedFields,
      missingFields,
      actionStatus,
      companyContext,
      actionCreated: true,
      leadId: lead.id,
      appointmentRequestId: request?.id || null,
    });
  }

  async preview(input: AttendantActionInput) {
    return this.analyzeAndPrepare({ ...input, dryRun: true });
  }

  private async upsertLead(
    input: AttendantActionInput,
    intent: AttendantIntent,
    actionStatus: AttendantActionStatus,
    fields: ExtractedAttendantFields,
  ) {
    const externalId = this.buildLeadExternalId(input.channel, input.customerExternalId);
    const metadata = this.toJson({
      source: 'attendant_action_layer',
      channel: input.channel,
      provider: input.provider,
      customerExternalId: input.customerExternalId,
      businessAccountId: input.businessAccountId || null,
      extractedFields: fields,
    });

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
        requestedService: fields.requestedService || undefined,
        requestedDate: this.parseDate(fields.desiredDate) || undefined,
        requestedTime: fields.desiredTime || undefined,
        notes: fields.notes || undefined,
        metadata,
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
        requestedService: fields.requestedService || null,
        requestedDate: this.parseDate(fields.desiredDate),
        requestedTime: fields.desiredTime || null,
        notes: fields.notes || null,
        metadata,
        lastInteraction: new Date(),
        score: this.scoreIntent(intent),
        status: 'NEW',
      },
      select: { id: true },
    });
  }

  private async upsertAppointmentRequest(
    input: AttendantActionInput,
    leadId: string,
    intent: AttendantIntent,
    status: AppointmentRequestStatus,
    fields: ExtractedAttendantFields,
  ) {
    const existing = await this.prisma.appointmentRequest.findFirst({
      where: input.sourceMessageId
        ? {
            companyId: input.companyId,
            sourceMessageId: input.sourceMessageId,
          }
        : {
            companyId: input.companyId,
            conversationId: input.conversationId || '',
            status: { in: ['NEEDS_INFO', 'PENDING_CONFIRMATION'] },
          },
      orderBy: { updatedAt: 'desc' },
      select: { id: true },
    });

    const data = {
      leadId,
      customerName: fields.customerName || undefined,
      phone: fields.phone || undefined,
      email: fields.email || undefined,
      intent,
      status,
      requestedService: fields.requestedService || undefined,
      requestedDate: this.parseDate(fields.desiredDate) || undefined,
      requestedTime: fields.desiredTime || undefined,
      notes: fields.notes || undefined,
      metadata: this.toJson({
        source: 'attendant_action_layer',
        channel: input.channel,
        provider: input.provider,
        customerExternalId: input.customerExternalId,
        businessAccountId: input.businessAccountId || null,
        extractedFields: fields,
      }),
    };

    if (existing) {
      return this.prisma.appointmentRequest.update({
        where: { id: existing.id },
        data,
        select: { id: true },
      });
    }

    return this.prisma.appointmentRequest.create({
      data: {
        companyId: input.companyId,
        conversationId: input.conversationId || '',
        leadId,
        channel: input.channel,
        provider: input.provider,
        customerExternalId: input.customerExternalId,
        customerName: fields.customerName || null,
        phone: fields.phone || null,
        email: fields.email || null,
        intent,
        status,
        requestedService: fields.requestedService || null,
        requestedDate: this.parseDate(fields.desiredDate),
        requestedTime: fields.desiredTime || null,
        notes: fields.notes || null,
        sourceMessageId: input.sourceMessageId || null,
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
    actionCreated: boolean;
    leadId?: string | null;
    appointmentRequestId?: string | null;
  }): AttendantActionAnalysis {
    return {
      intent: input.intent,
      extractedFields: input.extractedFields,
      missingFields: input.missingFields,
      actionStatus: input.actionStatus,
      actionCreated: input.actionCreated,
      leadId: input.leadId || null,
      appointmentRequestId: input.appointmentRequestId || null,
      promptContext: this.buildPromptContext(input),
    };
  }

  private buildPromptContext(input: {
    intent: AttendantIntent;
    extractedFields: ExtractedAttendantFields;
    missingFields: string[];
    actionStatus: AttendantActionStatus;
    companyContext: string;
    actionCreated: boolean;
    leadId?: string | null;
    appointmentRequestId?: string | null;
  }) {
    return [
      'Camada de acao do Atendente IA:',
      `Intent detectada: ${input.intent}.`,
      `Campos extraidos: ${JSON.stringify(input.extractedFields)}.`,
      `Campos faltantes: ${input.missingFields.length ? input.missingFields.join(', ') : 'nenhum'}.`,
      `Status da acao: ${input.actionStatus}.`,
      input.appointmentRequestId
        ? `AppointmentRequest salvo: ${input.appointmentRequestId}.`
        : input.actionCreated
          ? 'Lead/dados do cliente salvos.'
          : 'Nenhuma acao estruturada salva para esta mensagem.',
      input.companyContext,
      'Regras: pergunte dados faltantes; nao invente disponibilidade; confirme apenas quando houver sistema/dado real; se nao houver agenda real, diga que a solicitacao foi registrada para confirmacao da equipe.',
    ].join('\n');
  }

  private resolveActionStatus(
    intent: AttendantIntent,
    missingFields: string[],
  ): AttendantActionStatus {
    if (intent === 'HUMAN_HANDOFF' || intent === 'COMPLAINT_OR_PROBLEM') {
      return 'needs_human';
    }

    if (intent === 'SCHEDULE_REQUEST') {
      return missingFields.length ? 'needs_more_info' : 'pending_confirmation';
    }

    if (intent === 'CUSTOMER_DATA_CAPTURE') {
      return 'draft';
    }

    return 'draft';
  }

  private toAppointmentStatus(status: AttendantActionStatus): AppointmentRequestStatus {
    if (status === 'needs_human') {
      return 'NEEDS_HUMAN';
    }
    if (status === 'pending_confirmation') {
      return 'PENDING_CONFIRMATION';
    }
    if (status === 'confirmed') {
      return 'CONFIRMED';
    }
    return 'NEEDS_INFO';
  }

  private shouldPersist(intent: AttendantIntent) {
    return ['SCHEDULE_REQUEST', 'CUSTOMER_DATA_CAPTURE', 'HUMAN_HANDOFF'].includes(intent);
  }

  private scoreIntent(intent: AttendantIntent) {
    if (intent === 'SCHEDULE_REQUEST') {
      return 80;
    }
    if (intent === 'CUSTOMER_DATA_CAPTURE') {
      return 60;
    }
    if (intent === 'HUMAN_HANDOFF') {
      return 50;
    }
    return 20;
  }

  private buildLeadExternalId(channel: string, customerExternalId: string) {
    return `${channel}:${customerExternalId}`;
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
