import { z } from 'zod';

type RawEnv = Record<string, string | undefined>;

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1']);
const URL_PROTOCOL_PATTERN = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//;

function isLocalHost(hostname: string): boolean {
  return LOCAL_HOSTS.has(hostname.toLowerCase());
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function normalizeUrl(
  key: string,
  rawValue: string | undefined,
  options?: { allowHttpLocalhost?: boolean },
): string | undefined {
  const value = rawValue?.trim();
  if (!value) {
    return undefined;
  }

  const withProtocol = URL_PROTOCOL_PATTERN.test(value)
    ? value
    : `${value.startsWith('localhost') || value.startsWith('127.0.0.1') || value.startsWith('0.0.0.0') ? 'http' : 'https'}://${value}`;

  let parsed: URL;
  try {
    parsed = new URL(withProtocol);
  } catch {
    throw new Error(`${key} invalida: use uma URL absoluta com http:// ou https://`);
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`${key} invalida: apenas http:// ou https:// sao aceitos`);
  }

  if (
    parsed.protocol === 'http:' &&
    !(
      options?.allowHttpLocalhost &&
      isLocalHost(parsed.hostname)
    )
  ) {
    throw new Error(`${key} invalida: em ambiente publico use https://`);
  }

  return stripTrailingSlash(parsed.toString());
}

function normalizePositiveInteger(
  key: string,
  rawValue: string | undefined,
  fallback: number,
  constraints?: { min?: number; max?: number },
): string {
  const value = rawValue?.trim();
  if (!value) {
    return String(fallback);
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${key} invalida: informe um inteiro positivo`);
  }

  if (constraints?.min && parsed < constraints.min) {
    throw new Error(`${key} invalida: minimo ${constraints.min}`);
  }

  if (constraints?.max && parsed > constraints.max) {
    throw new Error(`${key} invalida: maximo ${constraints.max}`);
  }

  return String(parsed);
}

function requireEnv(
  key: string,
  rawValue: string | undefined,
  constraints?: { minLength?: number },
): string {
  const value = rawValue?.trim();
  if (!value) {
    throw new Error(`${key} precisa estar configurada`);
  }

  if (constraints?.minLength && value.length < constraints.minLength) {
    throw new Error(`${key} precisa ter pelo menos ${constraints.minLength} caracteres`);
  }

  return value;
}

export function validateEnvironment(config: RawEnv): RawEnv {
  const parsed = z.record(z.string(), z.string().optional()).parse(config);
  const normalized: RawEnv = { ...parsed };

  normalized.DATABASE_URL = requireEnv('DATABASE_URL', normalized.DATABASE_URL);
  normalized.JWT_SECRET = requireEnv('JWT_SECRET', normalized.JWT_SECRET, {
    minLength: 32,
  });

  normalized.EVOLUTION_BASE_URL = normalizeUrl(
    'EVOLUTION_BASE_URL',
    normalized.EVOLUTION_BASE_URL || normalized.EVOLUTION_API_URL,
    { allowHttpLocalhost: true },
  );
  normalized.EVOLUTION_API_URL = normalized.EVOLUTION_BASE_URL;
  normalized.N8N_API_URL = normalizeUrl('N8N_API_URL', normalized.N8N_API_URL, {
    allowHttpLocalhost: true,
  });
  normalized.N8N_WEBHOOK_URL = normalizeUrl(
    'N8N_WEBHOOK_URL',
    normalized.N8N_WEBHOOK_URL || normalized.N8N_INBOUND_WEBHOOK_URL,
    { allowHttpLocalhost: true },
  );
  normalized.N8N_AGENT_WEBHOOK_URL = normalizeUrl(
    'N8N_AGENT_WEBHOOK_URL',
    normalized.N8N_AGENT_WEBHOOK_URL || normalized.N8N_WEBHOOK_URL,
    { allowHttpLocalhost: true },
  );
  normalized.N8N_INBOUND_WEBHOOK_URL = normalizeUrl(
    'N8N_INBOUND_WEBHOOK_URL',
    normalized.N8N_WEBHOOK_URL,
    { allowHttpLocalhost: true },
  );
  normalized.BACKEND_URL = normalizeUrl('BACKEND_URL', normalized.BACKEND_URL, {
    allowHttpLocalhost: true,
  });
  normalized.APP_URL = normalizeUrl('APP_URL', normalized.APP_URL, {
    allowHttpLocalhost: true,
  });
  normalized.PUBLIC_API_URL = normalizeUrl(
    'PUBLIC_API_URL',
    normalized.PUBLIC_API_URL,
    { allowHttpLocalhost: true },
  );
  normalized.FRONTEND_URL = normalizeUrl(
    'FRONTEND_URL',
    normalized.FRONTEND_URL || normalized.FRONTEND_APP_URL,
    { allowHttpLocalhost: true },
  );
  normalized.FRONTEND_APP_URL = normalized.FRONTEND_URL;
  normalized.BILLING_PAYMENT_PROVIDER = 'STRIPE';

  const isProduction = String(normalized.NODE_ENV || '').toLowerCase() === 'production';
  if (isProduction) {
    normalized.JWT_REFRESH_SECRET = requireEnv(
      'JWT_REFRESH_SECRET',
      normalized.JWT_REFRESH_SECRET,
      { minLength: 32 },
    );
    if (normalized.JWT_REFRESH_SECRET === normalized.JWT_SECRET) {
      throw new Error('JWT_REFRESH_SECRET precisa ser diferente de JWT_SECRET em producao');
    }

    normalized.STRIPE_SECRET_KEY = requireEnv('STRIPE_SECRET_KEY', normalized.STRIPE_SECRET_KEY, {
      minLength: 16,
    });
    normalized.STRIPE_WEBHOOK_SECRET = requireEnv(
      'STRIPE_WEBHOOK_SECRET',
      normalized.STRIPE_WEBHOOK_SECRET,
      { minLength: 16 },
    );
    for (const key of [
      'STRIPE_PRICE_ESSENTIAL_MONTHLY',
      'STRIPE_PRICE_ESSENTIAL_YEARLY',
      'STRIPE_PRICE_PREMIUM_MONTHLY',
      'STRIPE_PRICE_PREMIUM_YEARLY',
      'STRIPE_PRICE_PRO_BUSINESS_MONTHLY',
      'STRIPE_PRICE_PRO_BUSINESS_YEARLY',
    ]) {
      normalized[key] = requireEnv(key, normalized[key], { minLength: 8 });
    }

    const hasMercadoLivreOAuth = Boolean(
      (normalized.ML_CLIENT_ID || normalized.MERCADOLIVRE_OAUTH_CLIENT_ID)?.trim(),
    );
    if (hasMercadoLivreOAuth) {
      normalized.ML_TOKEN_ENCRYPTION_KEY = requireEnv(
        'ML_TOKEN_ENCRYPTION_KEY',
        normalized.ML_TOKEN_ENCRYPTION_KEY || normalized.MERCADOLIVRE_TOKEN_ENCRYPTION_KEY,
        { minLength: 32 },
      );
      normalized.ML_STATE_SECRET = requireEnv(
        'ML_STATE_SECRET',
        normalized.ML_STATE_SECRET,
        { minLength: 32 },
      );
    }

    if (normalized.MERCADOLIVRE_WEBHOOK_SECRET_REQUIRED === 'true') {
      normalized.WEBHOOK_SECRET = requireEnv('WEBHOOK_SECRET', normalized.WEBHOOK_SECRET, {
        minLength: 16,
      });
    }
  }

  normalized.EVOLUTION_API_TIMEOUT_MS = normalizePositiveInteger(
    'EVOLUTION_API_TIMEOUT_MS',
    normalized.EVOLUTION_API_TIMEOUT_MS,
    10000,
    { min: 1000, max: 60000 },
  );
  normalized.EVOLUTION_API_MAX_RETRIES = normalizePositiveInteger(
    'EVOLUTION_API_MAX_RETRIES',
    normalized.EVOLUTION_API_MAX_RETRIES,
    2,
    { max: 5 },
  );
  normalized.EVOLUTION_API_INFO_TTL_MS = normalizePositiveInteger(
    'EVOLUTION_API_INFO_TTL_MS',
    normalized.EVOLUTION_API_INFO_TTL_MS,
    300000,
    { min: 60000, max: 3600000 },
  );

  const hasEvolutionUrl = Boolean(normalized.EVOLUTION_BASE_URL);
  const hasEvolutionKey = Boolean(normalized.EVOLUTION_API_KEY?.trim());

  if (hasEvolutionUrl !== hasEvolutionKey) {
    throw new Error(
      'EVOLUTION_BASE_URL e EVOLUTION_API_KEY precisam ser configuradas juntas',
    );
  }

  if (hasEvolutionUrl && !normalized.BACKEND_URL) {
    throw new Error(
      'BACKEND_URL precisa estar configurada para a Evolution apontar eventos ao backend',
    );
  }

  if (
    (normalized.N8N_AGENT_WEBHOOK_URL || normalized.N8N_WEBHOOK_URL) &&
    !normalized.INTERNAL_AUTOMATION_TOKEN?.trim()
  ) {
    throw new Error(
      'INTERNAL_AUTOMATION_TOKEN precisa estar configurado para a automacao n8n',
    );
  }

  return normalized;
}
