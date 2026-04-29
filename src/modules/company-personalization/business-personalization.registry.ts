export type BusinessType =
  | 'ecommerce_physical'
  | 'ecommerce_digital'
  | 'saas'
  | 'agency'
  | 'medical_clinic'
  | 'law_office'
  | 'local_services'
  | 'retail_store'
  | 'restaurant'
  | 'marketplace_seller'
  | 'other';

export type PersonalizationProfileInput = {
  businessType?: string | null;
  businessModel?: string | null;
  mainGoal?: string | null;
  salesChannel?: string | null;
  companySize?: string | null;
  monthlyRevenueRange?: string | null;
  dataMaturity?: string | null;
  originalBusinessDescription?: string | null;
  detectedBusinessType?: string | null;
  classificationConfidence?: number | null;
  usesPaidTraffic?: boolean | null;
  hasPhysicalProducts?: boolean | null;
  hasDigitalProducts?: boolean | null;
  hasServices?: boolean | null;
  usesWhatsAppForSales?: boolean | null;
  usesMarketplace?: boolean | null;
  hasSupportTeam?: boolean | null;
  hasOperationalCosts?: boolean | null;
  wantsAutomation?: boolean | null;
  wantsMarketAnalysis?: boolean | null;
};

export type CompanyModuleDefinition = {
  key: string;
  label: string;
  description: string;
  route: string;
  defaultEnabled: boolean;
  order: number;
};

export type AgentRecommendation = {
  tone: string;
  toneOfVoice: string;
  attendantActive: boolean;
  bufferEnabled: boolean;
  splitResponsesEnabled: boolean;
  imageReadingEnabled: boolean;
  audioToTextEnabled: boolean;
  humanPauseEnabled: boolean;
  internetSearchEnabled: boolean;
  debounceSeconds: number;
  maxContextMessages: number;
  systemPrompt: string;
  welcomeMessage: string;
  safetyBoundaries: string[];
};

export type PersonalizationRecommendations = {
  businessType: BusinessType;
  modules: string[];
  dashboardMetrics: string[];
  agent: AgentRecommendation;
  integrations: string[];
  firstActions: string[];
  reports: string[];
  insightTopics: string[];
};

export const BUSINESS_TYPES: Array<{ key: BusinessType; label: string }> = [
  { key: 'ecommerce_physical', label: 'E-commerce fisico' },
  { key: 'ecommerce_digital', label: 'Produto digital / infoproduto' },
  { key: 'saas', label: 'SaaS / software' },
  { key: 'agency', label: 'Agencia / marketing / trafego' },
  { key: 'medical_clinic', label: 'Clinica / saude' },
  { key: 'law_office', label: 'Advocacia' },
  { key: 'local_services', label: 'Servicos locais' },
  { key: 'retail_store', label: 'Loja fisica / varejo' },
  { key: 'restaurant', label: 'Restaurante / delivery' },
  { key: 'marketplace_seller', label: 'Marketplace seller' },
  { key: 'other', label: 'Outro' },
];

export const COMPANY_MODULES: CompanyModuleDefinition[] = [
  { key: 'dashboard', label: 'Dashboard', description: 'Visao central personalizada.', route: '/', defaultEnabled: true, order: 0 },
  { key: 'reports', label: 'Relatorios', description: 'Relatorios e exportacoes executivas.', route: '/reports', defaultEnabled: true, order: 1 },
  { key: 'chat', label: 'Chat IA', description: 'Analise conversacional dos dados.', route: '/chat', defaultEnabled: true, order: 2 },
  { key: 'attendant', label: 'Atendente IA', description: 'Atendimento e vendas via WhatsApp.', route: '/attendant', defaultEnabled: false, order: 3 },
  { key: 'insights', label: 'Insights', description: 'Alertas e diagnosticos de IA.', route: '/insights', defaultEnabled: true, order: 4 },
  { key: 'market_intelligence', label: 'Mercado', description: 'Radar de concorrencia e oportunidades.', route: '/market-intel', defaultEnabled: false, order: 5 },
  { key: 'automations', label: 'Projetos', description: 'Planos de acao e automacoes.', route: '/command-center', defaultEnabled: false, order: 6 },
  { key: 'products', label: 'Produtos', description: 'Catalogo, margem e mix de produtos.', route: '/products', defaultEnabled: false, order: 7 },
  { key: 'customers', label: 'Clientes', description: 'Base de clientes e relacionamento.', route: '/customers', defaultEnabled: true, order: 8 },
  { key: 'costs', label: 'Custos', description: 'Custos operacionais e desperdicios.', route: '/costs', defaultEnabled: false, order: 9 },
  { key: 'financial', label: 'Financeiro', description: 'Fluxo financeiro e transacoes.', route: '/financial-flow', defaultEnabled: true, order: 10 },
  { key: 'integrations', label: 'Integracoes', description: 'WhatsApp, dados e canais externos.', route: '/integrations', defaultEnabled: true, order: 11 },
  { key: 'companies', label: 'Empresas', description: 'Gestao de empresas vinculadas.', route: '/companies', defaultEnabled: true, order: 12 },
  { key: 'settings', label: 'Configuracoes', description: 'Preferencias e personalizacao.', route: '/settings', defaultEnabled: true, order: 13 },
  { key: 'profile', label: 'Perfil', description: 'Conta e seguranca.', route: '/profile', defaultEnabled: true, order: 14 },
  { key: 'plans', label: 'Planos', description: 'Assinatura e limites.', route: '/plans', defaultEnabled: true, order: 15 },
];

const MODULE_KEYS = new Set(COMPANY_MODULES.map((module) => module.key));
const BUSINESS_TYPE_KEYS = new Set(BUSINESS_TYPES.map((item) => item.key));

type RecommendationTemplate = {
  modules: string[];
  metrics: string[];
  integrations: string[];
  firstActions: string[];
  reports: string[];
  insightTopics: string[];
  agent: Omit<AgentRecommendation, 'systemPrompt' | 'welcomeMessage'> & {
    role: string;
    promptSafety: string[];
  };
};

const COMMON_REPORTS = ['resumo_financeiro', 'diagnostico_periodo', 'plano_de_acao'];

const TEMPLATES: Record<BusinessType, RecommendationTemplate> = {
  ecommerce_physical: {
    modules: ['dashboard', 'products', 'customers', 'financial', 'marketing', 'attendant', 'reports', 'market_intelligence', 'integrations', 'costs'],
    metrics: ['revenue', 'net_profit', 'margin', 'average_ticket', 'cac', 'roas', 'best_selling_products', 'profit_by_product', 'operational_costs', 'peak_sales_hours'],
    integrations: ['whatsapp', 'ad_spend', 'marketplace', 'catalog'],
    firstActions: ['Cadastrar produtos', 'Conectar WhatsApp', 'Registrar custos', 'Configurar anuncios'],
    reports: [...COMMON_REPORTS, 'margem_por_produto', 'mix_de_vendas'],
    insightTopics: ['margem', 'produtos campeoes', 'desperdicio operacional', 'campanhas'],
    agent: {
      role: 'atendente consultivo e vendedor de um e-commerce',
      tone: 'consultivo e vendedor',
      toneOfVoice: 'consultivo',
      attendantActive: true,
      bufferEnabled: true,
      splitResponsesEnabled: true,
      imageReadingEnabled: true,
      audioToTextEnabled: false,
      humanPauseEnabled: true,
      internetSearchEnabled: false,
      debounceSeconds: 3,
      maxContextMessages: 20,
      safetyBoundaries: ['Nao inventar precos, prazos ou estoque.', 'Encaminhar para humano quando houver reclamacao ou duvida sensivel.'],
      promptSafety: ['Nao invente precos, estoque ou politica de troca.', 'Encaminhe para humano quando necessario.'],
    },
  },
  ecommerce_digital: {
    modules: ['dashboard', 'customers', 'financial', 'reports', 'attendant', 'automations', 'integrations'],
    metrics: ['revenue', 'conversion_rate', 'cac', 'roas', 'refund_rate', 'net_profit', 'average_ticket', 'funnel_conversion'],
    integrations: ['whatsapp', 'ad_spend', 'checkout'],
    firstActions: ['Conectar fonte de vendas', 'Registrar investimento em trafego', 'Configurar follow-up no WhatsApp'],
    reports: [...COMMON_REPORTS, 'funil_de_vendas', 'reembolsos'],
    insightTopics: ['conversao', 'campanhas', 'ticket medio', 'reembolso'],
    agent: {
      role: 'atendente consultivo para venda de produto digital',
      tone: 'direto e persuasivo',
      toneOfVoice: 'consultivo',
      attendantActive: true,
      bufferEnabled: true,
      splitResponsesEnabled: true,
      imageReadingEnabled: false,
      audioToTextEnabled: true,
      humanPauseEnabled: true,
      internetSearchEnabled: false,
      debounceSeconds: 3,
      maxContextMessages: 20,
      safetyBoundaries: ['Nao prometer resultado financeiro garantido.', 'Encaminhar duvidas de pagamento para humano.'],
      promptSafety: ['Nao prometa resultado garantido.', 'Colete contexto antes de recomendar o produto.'],
    },
  },
  saas: {
    modules: ['dashboard', 'customers', 'financial', 'reports', 'insights', 'attendant'],
    metrics: ['mrr', 'churn', 'ltv', 'cac', 'activation_rate', 'retention', 'active_customers', 'plan_conversion'],
    integrations: ['billing', 'crm', 'support'],
    firstActions: ['Importar clientes', 'Registrar planos', 'Conectar atendimento'],
    reports: [...COMMON_REPORTS, 'retencao', 'ativacao'],
    insightTopics: ['retencao', 'churn', 'ativacao', 'expansao'],
    agent: {
      role: 'assistente de suporte e sucesso do cliente SaaS',
      tone: 'claro e tecnico sem ser frio',
      toneOfVoice: 'profissional',
      attendantActive: true,
      bufferEnabled: true,
      splitResponsesEnabled: false,
      imageReadingEnabled: true,
      audioToTextEnabled: false,
      humanPauseEnabled: true,
      internetSearchEnabled: false,
      debounceSeconds: 3,
      maxContextMessages: 24,
      safetyBoundaries: ['Nao prometer roadmap ou SLA nao cadastrado.', 'Encaminhar incidentes para humano.'],
      promptSafety: ['Ajude com suporte inicial e colete contexto tecnico.', 'Encaminhe incidentes criticos para humano.'],
    },
  },
  agency: {
    modules: ['dashboard', 'customers', 'financial', 'reports', 'attendant', 'automations'],
    metrics: ['revenue', 'client_revenue', 'operational_costs', 'profit_margin', 'customer_retention', 'lead_conversion'],
    integrations: ['whatsapp', 'crm', 'ad_spend'],
    firstActions: ['Cadastrar clientes', 'Registrar custos por operacao', 'Criar rotina de relatorios'],
    reports: [...COMMON_REPORTS, 'rentabilidade_por_cliente'],
    insightTopics: ['clientes lucrativos', 'retencao', 'custos de equipe'],
    agent: {
      role: 'assistente comercial de agencia',
      tone: 'estrategico e objetivo',
      toneOfVoice: 'profissional',
      attendantActive: true,
      bufferEnabled: true,
      splitResponsesEnabled: false,
      imageReadingEnabled: false,
      audioToTextEnabled: true,
      humanPauseEnabled: true,
      internetSearchEnabled: false,
      debounceSeconds: 3,
      maxContextMessages: 20,
      safetyBoundaries: ['Nao prometer resultado de campanha.', 'Encaminhar proposta e negociacao final para humano.'],
      promptSafety: ['Nao prometa resultados de campanha.', 'Qualifique o lead antes de encaminhar.'],
    },
  },
  medical_clinic: {
    modules: ['dashboard', 'customers', 'attendant', 'financial', 'reports', 'integrations'],
    metrics: ['appointments', 'no_show_rate', 'service_revenue', 'new_patients', 'returning_patients', 'average_ticket'],
    integrations: ['whatsapp', 'scheduling'],
    firstActions: ['Conectar WhatsApp', 'Cadastrar servicos/consultas', 'Definir mensagens de agendamento'],
    reports: [...COMMON_REPORTS, 'agenda', 'retorno_de_pacientes'],
    insightTopics: ['agenda', 'faltas', 'retorno', 'receita por servico'],
    agent: {
      role: 'atendente de clinica',
      tone: 'acolhedor e profissional',
      toneOfVoice: 'acolhedor',
      attendantActive: true,
      bufferEnabled: true,
      splitResponsesEnabled: false,
      imageReadingEnabled: false,
      audioToTextEnabled: true,
      humanPauseEnabled: true,
      internetSearchEnabled: false,
      debounceSeconds: 4,
      maxContextMessages: 16,
      safetyBoundaries: ['Nao dar diagnostico medico.', 'Coletar informacoes basicas e orientar contato com a equipe.'],
      promptSafety: ['Nao de diagnostico medico.', 'Oriente o cliente a falar com a equipe clinica.'],
    },
  },
  law_office: {
    modules: ['dashboard', 'customers', 'attendant', 'financial', 'reports'],
    metrics: ['leads', 'consultations', 'case_pipeline', 'client_followup', 'service_revenue', 'lead_conversion'],
    integrations: ['whatsapp', 'crm'],
    firstActions: ['Conectar WhatsApp', 'Cadastrar tipos de caso', 'Definir triagem juridica'],
    reports: [...COMMON_REPORTS, 'pipeline_juridico'],
    insightTopics: ['leads', 'consultas', 'follow-up', 'pipeline'],
    agent: {
      role: 'atendente de escritorio juridico',
      tone: 'formal e objetivo',
      toneOfVoice: 'formal',
      attendantActive: true,
      bufferEnabled: true,
      splitResponsesEnabled: false,
      imageReadingEnabled: false,
      audioToTextEnabled: true,
      humanPauseEnabled: true,
      internetSearchEnabled: false,
      debounceSeconds: 4,
      maxContextMessages: 16,
      safetyBoundaries: ['Nao dar parecer juridico definitivo.', 'Coletar contexto inicial e encaminhar para analise humana.'],
      promptSafety: ['Nao de parecer juridico definitivo.', 'Colete contexto inicial e encaminhe para analise humana.'],
    },
  },
  local_services: {
    modules: ['dashboard', 'customers', 'attendant', 'financial', 'reports', 'costs'],
    metrics: ['service_revenue', 'bookings', 'repeat_customers', 'average_ticket', 'operational_costs'],
    integrations: ['whatsapp', 'scheduling'],
    firstActions: ['Cadastrar servicos', 'Conectar WhatsApp', 'Registrar custos recorrentes'],
    reports: [...COMMON_REPORTS, 'servicos_mais_vendidos'],
    insightTopics: ['agenda', 'recorrencia', 'custos', 'ticket medio'],
    agent: {
      role: 'atendente de servicos locais',
      tone: 'prestativo e direto',
      toneOfVoice: 'consultivo',
      attendantActive: true,
      bufferEnabled: true,
      splitResponsesEnabled: false,
      imageReadingEnabled: false,
      audioToTextEnabled: true,
      humanPauseEnabled: true,
      internetSearchEnabled: false,
      debounceSeconds: 3,
      maxContextMessages: 18,
      safetyBoundaries: ['Nao confirmar agenda sem dados oficiais.', 'Encaminhar negociacoes sensiveis para humano.'],
      promptSafety: ['Qualifique a necessidade e encaminhe agendamento quando necessario.'],
    },
  },
  retail_store: {
    modules: ['dashboard', 'products', 'customers', 'financial', 'reports', 'costs'],
    metrics: ['revenue', 'best_selling_products', 'stock_movement', 'peak_sales_hours', 'average_ticket', 'repeat_customers'],
    integrations: ['catalog'],
    firstActions: ['Cadastrar produtos', 'Registrar vendas', 'Registrar custos da loja'],
    reports: [...COMMON_REPORTS, 'mix_de_produtos'],
    insightTopics: ['pico de venda', 'mix', 'recorrencia', 'estoque'],
    agent: {
      role: 'assistente de loja fisica',
      tone: 'amigavel e vendedor',
      toneOfVoice: 'consultivo',
      attendantActive: false,
      bufferEnabled: true,
      splitResponsesEnabled: true,
      imageReadingEnabled: true,
      audioToTextEnabled: false,
      humanPauseEnabled: true,
      internetSearchEnabled: false,
      debounceSeconds: 3,
      maxContextMessages: 18,
      safetyBoundaries: ['Nao inventar estoque ou preco.', 'Confirmar disponibilidade com a equipe.'],
      promptSafety: ['Nao invente estoque ou preco.', 'Ajude a escolher produtos e confirme com humano quando necessario.'],
    },
  },
  restaurant: {
    modules: ['dashboard', 'products', 'customers', 'attendant', 'reports', 'costs'],
    metrics: ['revenue', 'average_ticket', 'peak_hours', 'best_selling_items', 'delivery_costs', 'repeat_customers'],
    integrations: ['whatsapp', 'delivery'],
    firstActions: ['Cadastrar cardapio', 'Conectar WhatsApp', 'Registrar custos de entrega'],
    reports: [...COMMON_REPORTS, 'itens_mais_vendidos'],
    insightTopics: ['horarios de pico', 'cardapio', 'delivery', 'recorrencia'],
    agent: {
      role: 'atendente de restaurante e delivery',
      tone: 'rapido e simpatico',
      toneOfVoice: 'amigavel',
      attendantActive: true,
      bufferEnabled: true,
      splitResponsesEnabled: true,
      imageReadingEnabled: true,
      audioToTextEnabled: true,
      humanPauseEnabled: true,
      internetSearchEnabled: false,
      debounceSeconds: 2,
      maxContextMessages: 12,
      safetyBoundaries: ['Nao confirmar pedido sem integracao ou humano.', 'Nao inventar disponibilidade do cardapio.'],
      promptSafety: ['Ajude com duvidas do cardapio, mas nao confirme pedido sem dados oficiais.'],
    },
  },
  marketplace_seller: {
    modules: ['dashboard', 'products', 'customers', 'financial', 'integrations', 'reports', 'market_intelligence', 'costs'],
    metrics: ['revenue', 'marketplace_fees', 'profit_by_product', 'best_selling_products', 'shipping_costs', 'roas'],
    integrations: ['marketplace', 'ad_spend', 'catalog'],
    firstActions: ['Cadastrar produtos', 'Registrar taxas do marketplace', 'Conectar dados de anuncio'],
    reports: [...COMMON_REPORTS, 'taxas_marketplace', 'margem_por_produto'],
    insightTopics: ['taxas', 'frete', 'margem', 'preco de mercado'],
    agent: {
      role: 'assistente de seller de marketplace',
      tone: 'objetivo e comercial',
      toneOfVoice: 'consultivo',
      attendantActive: true,
      bufferEnabled: true,
      splitResponsesEnabled: true,
      imageReadingEnabled: true,
      audioToTextEnabled: false,
      humanPauseEnabled: true,
      internetSearchEnabled: false,
      debounceSeconds: 3,
      maxContextMessages: 18,
      safetyBoundaries: ['Nao inventar prazo, frete ou politica do marketplace.', 'Encaminhar problemas de pedido para humano.'],
      promptSafety: ['Nao invente prazo, frete ou politica do marketplace.'],
    },
  },
  other: {
    modules: ['dashboard', 'financial', 'customers', 'attendant', 'reports', 'insights'],
    metrics: ['revenue', 'net_profit', 'average_ticket', 'customers_acquired', 'operational_costs'],
    integrations: ['whatsapp'],
    firstActions: ['Registrar primeiras vendas', 'Cadastrar clientes', 'Conectar WhatsApp se usar atendimento'],
    reports: COMMON_REPORTS,
    insightTopics: ['financeiro', 'clientes', 'operacao'],
    agent: {
      role: 'assistente de atendimento empresarial',
      tone: 'profissional e prestativo',
      toneOfVoice: 'consultivo',
      attendantActive: false,
      bufferEnabled: true,
      splitResponsesEnabled: false,
      imageReadingEnabled: false,
      audioToTextEnabled: false,
      humanPauseEnabled: true,
      internetSearchEnabled: false,
      debounceSeconds: 3,
      maxContextMessages: 18,
      safetyBoundaries: ['Nao inventar informacoes comerciais.', 'Encaminhar casos sensiveis para humano.'],
      promptSafety: ['Seja claro, objetivo e encaminhe para humano quando faltar informacao.'],
    },
  },
};

export function normalizeBusinessType(value?: string | null): BusinessType {
  const normalized = String(value || '').trim().toLowerCase();
  return BUSINESS_TYPE_KEYS.has(normalized as BusinessType) ? (normalized as BusinessType) : 'other';
}

export function isKnownModuleKey(value: string) {
  return MODULE_KEYS.has(value);
}

export function buildPersonalizationRecommendations(
  profile: PersonalizationProfileInput,
  companyName?: string | null,
): PersonalizationRecommendations {
  const businessType = normalizeBusinessType(profile.businessType);
  const template = TEMPLATES[businessType] || TEMPLATES.other;
  const modules = new Set(template.modules.filter((key) => MODULE_KEYS.has(key)));
  const metrics = new Set(template.metrics);
  const integrations = new Set(template.integrations);
  const firstActions = new Set(template.firstActions);
  const reports = new Set(template.reports);
  const insightTopics = new Set(template.insightTopics);

  modules.add('dashboard');
  modules.add('settings');
  modules.add('profile');
  modules.add('plans');

  if (profile.usesPaidTraffic) {
    metrics.add('cac');
    metrics.add('roas');
    integrations.add('ad_spend');
    firstActions.add('Registrar investimento em trafego');
  }

  if (profile.hasPhysicalProducts || profile.hasDigitalProducts) {
    modules.add('products');
    metrics.add('best_selling_products');
    metrics.add('margin');
    firstActions.add('Cadastrar produtos');
  }

  if (profile.hasServices) {
    metrics.add('service_revenue');
    metrics.add('average_ticket');
    modules.add('customers');
  }

  if (profile.usesWhatsAppForSales || profile.hasSupportTeam) {
    modules.add('attendant');
    modules.add('integrations');
    integrations.add('whatsapp');
    firstActions.add('Conectar WhatsApp');
  }

  if (profile.usesMarketplace) {
    modules.add('integrations');
    modules.add('products');
    integrations.add('marketplace');
    metrics.add('marketplace_fees');
  }

  if (profile.hasOperationalCosts) {
    modules.add('costs');
    metrics.add('operational_costs');
  }

  if (profile.wantsAutomation) {
    modules.add('automations');
    modules.add('attendant');
    firstActions.add('Criar primeira automacao');
  }

  if (profile.wantsMarketAnalysis) {
    modules.add('market_intelligence');
    metrics.add('market_opportunities');
    integrations.add('market_intelligence');
    firstActions.add('Ativar radar de mercado');
  }

  const agent = buildAgentRecommendation(template, profile, companyName);

  return {
    businessType,
    modules: Array.from(modules),
    dashboardMetrics: Array.from(metrics),
    agent,
    integrations: Array.from(integrations),
    firstActions: Array.from(firstActions),
    reports: Array.from(reports),
    insightTopics: Array.from(insightTopics),
  };
}

function buildAgentRecommendation(
  template: RecommendationTemplate,
  profile: PersonalizationProfileInput,
  companyName?: string | null,
): AgentRecommendation {
  const name = companyName?.trim() || 'empresa';
  const goal = profile.mainGoal?.trim()
    ? ` Objetivo principal agora: ${profile.mainGoal.trim()}.`
    : '';
  const businessModel = profile.businessModel?.trim()
    ? ` Modelo de negocio: ${profile.businessModel.trim()}.`
    : '';
  const safety = template.agent.promptSafety.join(' ');

  return {
    tone: template.agent.tone,
    toneOfVoice: template.agent.toneOfVoice,
    attendantActive: Boolean(profile.usesWhatsAppForSales || profile.wantsAutomation || template.agent.attendantActive),
    bufferEnabled: template.agent.bufferEnabled,
    splitResponsesEnabled: template.agent.splitResponsesEnabled,
    imageReadingEnabled: template.agent.imageReadingEnabled,
    audioToTextEnabled: template.agent.audioToTextEnabled,
    humanPauseEnabled: template.agent.humanPauseEnabled,
    internetSearchEnabled: template.agent.internetSearchEnabled,
    debounceSeconds: template.agent.debounceSeconds,
    maxContextMessages: template.agent.maxContextMessages,
    safetyBoundaries: template.agent.safetyBoundaries,
    welcomeMessage: `Oi! Sou o atendimento da ${name}. Como posso ajudar?`,
    systemPrompt:
      `Voce e um ${template.agent.role} da ${name}. ` +
      `Use tom ${template.agent.tone}.` +
      businessModel +
      goal +
      ` Responda com clareza, faca perguntas objetivas quando faltar contexto e nao invente informacoes. ${safety}`,
  };
}
