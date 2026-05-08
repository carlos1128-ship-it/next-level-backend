import { IntegrationProvider } from '@prisma/client';

export type AttendantIntent =
  | 'GENERAL_QUESTION'
  | 'SCHEDULE_REQUEST'
  | 'MEETING_REQUEST'
  | 'SERVICE_REQUEST'
  | 'QUOTE_REQUEST'
  | 'PRODUCT_INTEREST'
  | 'SERVICE_INFORMATION'
  | 'CUSTOMER_DATA_CAPTURE'
  | 'HUMAN_HANDOFF'
  | 'UNKNOWN';

export type AttendantActionStatus =
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
  objective?: string | null;
  preferredContactMethod?: string | null;
  urgency?: string | null;
  budget?: string | null;
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
  shouldCreateCustomer: boolean;
  shouldCreateActionRequest: boolean;
  customerId?: string | null;
  leadId?: string | null;
  appointmentRequestId?: string | null;
  businessActionRequestId?: string | null;
  actionCreated: boolean;
  draftSaved: boolean;
  customerCreatedOrUpdated?: boolean;
  customerCreated?: boolean;
  customerUpdated?: boolean;
  leadCreatedOrUpdated?: boolean;
  businessActionRequestCreatedOrUpdated?: boolean;
  businessActionRequestCreated?: boolean;
  appearsInCustomers?: boolean;
  registrationClaimAllowed?: boolean;
  isComplete?: boolean;
  justSaved?: boolean;
  userConfirmed?: boolean;
  shouldAskConfirmation?: boolean;
  shouldFinalize?: boolean;
  ok?: boolean;
  errorClassification?: string | null;
  shouldContinueAiResponse?: boolean;
  shouldAskMissingFields?: boolean;
  shouldHumanHandoff?: boolean;
  assistantInstruction?: string;
  nextAssistantInstruction: string;
  promptContext: string;
};
