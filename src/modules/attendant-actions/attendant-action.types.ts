import { IntegrationProvider } from '@prisma/client';

export type AttendantIntent =
  | 'GENERAL_QUESTION'
  | 'SCHEDULE_REQUEST'
  | 'PRICE_REQUEST'
  | 'SERVICE_INFORMATION'
  | 'CUSTOMER_DATA_CAPTURE'
  | 'HUMAN_HANDOFF'
  | 'COMPLAINT_OR_PROBLEM'
  | 'ORDER_OR_SERVICE_STATUS'
  | 'UNKNOWN';

export type AttendantActionStatus =
  | 'draft'
  | 'needs_more_info'
  | 'pending_confirmation'
  | 'confirmed'
  | 'needs_human';

export type AppointmentRequestStatus =
  | 'NEEDS_INFO'
  | 'PENDING_CONFIRMATION'
  | 'CONFIRMED'
  | 'CANCELLED'
  | 'NEEDS_HUMAN';

export type ExtractedAttendantFields = {
  customerName?: string | null;
  phone?: string | null;
  email?: string | null;
  desiredDate?: string | null;
  desiredTime?: string | null;
  requestedService?: string | null;
  notes?: string | null;
};

export type AttendantActionInput = {
  companyId: string;
  conversationId?: string | null;
  sourceMessageId?: string | null;
  channel: string;
  provider: IntegrationProvider;
  customerExternalId: string;
  text: string;
  businessAccountId?: string | null;
  dryRun?: boolean;
};

export type AttendantActionAnalysis = {
  intent: AttendantIntent;
  extractedFields: ExtractedAttendantFields;
  missingFields: string[];
  actionStatus: AttendantActionStatus;
  leadId?: string | null;
  appointmentRequestId?: string | null;
  actionCreated: boolean;
  promptContext: string;
};
