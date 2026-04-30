export const INTELLIGENT_IMPORT_INPUT_TYPES = {
  IMAGE: 'IMAGE',
  PDF: 'PDF',
  CSV: 'CSV',
  TEXT: 'TEXT',
  DOCUMENT: 'DOCUMENT',
} as const;

export const INTELLIGENT_IMPORT_STATUSES = {
  UPLOADED: 'UPLOADED',
  ANALYZING: 'ANALYZING',
  NEEDS_REVIEW: 'NEEDS_REVIEW',
  CONFIRMED: 'CONFIRMED',
  REJECTED: 'REJECTED',
  FAILED: 'FAILED',
} as const;

export const INTELLIGENT_IMPORT_CATEGORIES = {
  MARKETING: 'MARKETING',
  DELIVERY: 'DELIVERY',
  MARKETPLACE: 'MARKETPLACE',
  FINANCIAL: 'FINANCIAL',
  PRODUCTS: 'PRODUCTS',
  CUSTOMERS: 'CUSTOMERS',
  MIXED: 'MIXED',
  UNKNOWN: 'UNKNOWN',
} as const;

export const IMPORTED_METRIC_UNITS = {
  CURRENCY: 'CURRENCY',
  PERCENTAGE: 'PERCENTAGE',
  COUNT: 'COUNT',
  RATIO: 'RATIO',
  TEXT: 'TEXT',
} as const;

export const IMPORTED_METRIC_SOURCES = {
  AI_IMPORT: 'AI_IMPORT',
  CSV_IMPORT: 'CSV_IMPORT',
  MANUAL_TEXT: 'MANUAL_TEXT',
  SCREENSHOT: 'SCREENSHOT',
  PDF: 'PDF',
} as const;

export const IMPORTED_METRIC_STATUSES = {
  PENDING_REVIEW: 'PENDING_REVIEW',
  CONFIRMED: 'CONFIRMED',
  REJECTED: 'REJECTED',
} as const;

export const IMPORTED_ENTITY_TYPES = {
  PRODUCT: 'PRODUCT',
  CUSTOMER: 'CUSTOMER',
  ORDER: 'ORDER',
  ORDER_ITEM: 'ORDER_ITEM',
  CAMPAIGN: 'CAMPAIGN',
  AD: 'AD',
  COST: 'COST',
  UNKNOWN: 'UNKNOWN',
} as const;

export const IMPORTED_ENTITY_STATUSES = {
  PENDING_REVIEW: 'PENDING_REVIEW',
  CONFIRMED: 'CONFIRMED',
  REJECTED: 'REJECTED',
} as const;

export type IntelligentImportInputTypeValue =
  (typeof INTELLIGENT_IMPORT_INPUT_TYPES)[keyof typeof INTELLIGENT_IMPORT_INPUT_TYPES];
export type IntelligentImportStatusValue =
  (typeof INTELLIGENT_IMPORT_STATUSES)[keyof typeof INTELLIGENT_IMPORT_STATUSES];
export type IntelligentImportCategoryValue =
  (typeof INTELLIGENT_IMPORT_CATEGORIES)[keyof typeof INTELLIGENT_IMPORT_CATEGORIES];
export type ImportedMetricUnitValue =
  (typeof IMPORTED_METRIC_UNITS)[keyof typeof IMPORTED_METRIC_UNITS];
export type ImportedMetricSourceValue =
  (typeof IMPORTED_METRIC_SOURCES)[keyof typeof IMPORTED_METRIC_SOURCES];
export type ImportedEntityTypeValue =
  (typeof IMPORTED_ENTITY_TYPES)[keyof typeof IMPORTED_ENTITY_TYPES];

export const EXPECTED_CATEGORY_VALUES = [
  'auto',
  'marketing',
  'delivery',
  'marketplace',
  'financial',
  'products',
  'customers',
  'sales',
  'other',
] as const;

export const SUPPORTED_UPLOAD_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'application/pdf',
  'text/csv',
  'text/plain',
  'application/vnd.ms-excel',
]);

export const MAX_IMPORT_FILE_SIZE_BYTES = 10 * 1024 * 1024;

export const CATEGORY_LABELS: Record<IntelligentImportCategoryValue, string> = {
  MARKETING: 'Marketing / Trafego',
  DELIVERY: 'Delivery',
  MARKETPLACE: 'Marketplace',
  FINANCIAL: 'Financeiro',
  PRODUCTS: 'Produtos',
  CUSTOMERS: 'Clientes',
  MIXED: 'Misto',
  UNKNOWN: 'Desconhecido',
};
