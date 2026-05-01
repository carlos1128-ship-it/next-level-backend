export type BusinessPeriod = 'today' | 'yesterday' | '7d' | '30d' | 'month' | 'year';

export type BusinessMetricSnapshot = {
  period: {
    key: BusinessPeriod;
    startDate: string;
    endDate: string;
  };
  revenue: number;
  costs: number;
  profit: number;
  margin: number | null;
  averageTicket: number | null;
  salesCount: number;
  customerCount: number;
  productCount: number;
  inactiveCustomers: number;
  operationalWaste: number | null;
  salesByProduct: Array<{
    productName: string;
    revenue: number;
    salesCount: number;
  }>;
  profitByProduct: Array<{
    productName: string;
    revenue: number;
    estimatedCost: number;
    estimatedProfit: number;
    margin: number | null;
  }>;
  peakHours: Array<{
    hour: number;
    salesCount: number;
    revenue: number;
  }>;
  risks: string[];
  opportunities: string[];
};

export type BusinessContext = {
  company: {
    id: string;
    name: string;
    sector: string | null;
    segment: string | null;
    currency: string;
  };
  profile: Record<string, unknown> | null;
  metrics: BusinessMetricSnapshot;
  recentEvents: Array<Record<string, unknown>>;
  recentInsights: Array<Record<string, unknown>>;
  recentAlerts: Array<Record<string, unknown>>;
  recentRecommendations: Array<Record<string, unknown>>;
  recentWhatsappSignals: Array<Record<string, unknown>>;
  memory: Array<Record<string, unknown>>;
  missingData: string[];
  availableData: string[];
};

export type AiBusinessCard = {
  type: string;
  title: string;
  summary: string;
  impact?: string | null;
  recommendation?: string | null;
  priority: 'low' | 'medium' | 'high' | 'critical';
  source: string;
};

export type AiDashboardIntelligence = {
  period: BusinessContext['metrics']['period'];
  mainInsight: AiBusinessCard;
  mainRisk: AiBusinessCard | null;
  growthOpportunity: AiBusinessCard | null;
  recommendedAction: AiBusinessCard | null;
  productAttention: AiBusinessCard | null;
  customerAttention: AiBusinessCard | null;
  costAttention: AiBusinessCard | null;
  whatsappSignal: AiBusinessCard | null;
  nextBestActions: AiBusinessCard[];
  missingData: string[];
  generatedFrom: 'backend_metrics';
};
