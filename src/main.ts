import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { RequestMethod } from '@nestjs/common';
import { Request, Response } from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { AppModule } from './app.module';
import { ZodValidationPipe } from './common/pipes/zod-validation.pipe';

const normalizeOrigin = (value?: string) =>
  value?.trim().replace(/\/$/, "");

function getAllowedOrigins(): string[] {
  const envOrigins = [
    process.env.FRONTEND_URL,
    process.env.CLIENT_URL,
    process.env.APP_URL,
    process.env.WEB_URL,
    process.env.CORS_ORIGIN,
    ...(process.env.CORS_ORIGINS?.split(",") ?? []),
    ...(process.env.ALLOWED_ORIGINS?.split(",") ?? []),
  ]
    .map(normalizeOrigin)
    .filter((o): o is string => !!o);

  const defaults = [
    "http://localhost:3000",
    "http://localhost:5173",
    "https://nextlevel.qzz.io",
    "https://next-level-front.vercel.app",
  ];

  return Array.from(new Set([
    ...envOrigins,
    ...defaults,
  ]));
}

function isAllowedVercelPreview(origin: string): boolean {
  try {
    const url = new URL(origin);
    if (url.protocol !== 'https:') return false;
    if (!url.hostname.endsWith('.vercel.app')) return false;
    return url.hostname.startsWith('next-level-front');
  } catch {
    return false;
  }
}

function parseTrustProxy(raw: string | undefined): boolean | number {
  if (!raw) return false;
  const normalized = raw.trim().toLowerCase();
  if (['true', 'yes', 'on'].includes(normalized)) return true;
  const numeric = Number(normalized);
  if (Number.isFinite(numeric) && numeric >= 0) return numeric;
  return false;
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    rawBody: true,
  });
  const allowedOrigins = getAllowedOrigins();
  const expressApp = app.getHttpAdapter().getInstance();
  const trustProxy = parseTrustProxy(
    process.env.TRUST_PROXY ??
    (process.env.NODE_ENV === 'production' ? '1' : 'false'),
  );

  expressApp.get('/', (_req: Request, res: Response) => {
    res.status(200).json({
      ok: true,
      service: 'next-level-backend',
      timestamp: new Date().toISOString(),
    });
  });

  expressApp.head('/', (_req: Request, res: Response) => {
    res.status(200).end();
  });

  app.setGlobalPrefix('api', {
    exclude: [
      { path: 'webhook/whatsapp', method: RequestMethod.POST },
      { path: 'webhook/ml', method: RequestMethod.POST },
      // Meta Cloud API webhook must be reachable WITHOUT /api prefix
      { path: 'webhooks/meta', method: RequestMethod.GET },
      { path: 'webhooks/meta', method: RequestMethod.POST },
    ],
  });
  app.useGlobalPipes(
    new ZodValidationPipe(),
    new ValidationPipe({
      transform: true,
      transformOptions: { enableImplicitConversion: true },
      whitelist: true,
      forbidUnknownValues: false,
    }),
  );
  app.use(helmet());
  expressApp.set('trust proxy', trustProxy);
  app.use(
    rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 600,
      standardHeaders: true,
      legacyHeaders: false,
      skip: (req) =>
        req.path.startsWith('/api/evolution/webhook') ||
        req.path.startsWith('/api/whatsapp/webhooks/evolution') ||
        req.path.startsWith('/api/billing/webhook/stripe') ||
        req.path.startsWith('/api/instagram/webhook') ||
        req.path.startsWith('/webhook/ml') ||
        req.path.startsWith('/webhooks/'),
    }),
  );

  app.enableCors({
    origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
      if (!origin) return callback(null, true);

      const normalizedOrigin = normalizeOrigin(origin);

      if (
        normalizedOrigin && (
          allowedOrigins.includes(normalizedOrigin) ||
          isAllowedVercelPreview(origin)
        )
      ) {
        return callback(null, true);
      }

      return callback(new Error(`CORS blocked for origin: ${origin}`), false);
    },
    credentials: true,
    methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'x-company-id',
      'stripe-signature',
      'x-webhook-secret',
      'x-webhook-signature',
      'x-meli-signature',
      'x-signature',
    ],
  });

  const port = process.env.PORT || 3333;
  await app.listen(port, '0.0.0.0');
  const url = await app.getUrl();
  console.log(`🚀 Application is running on: ${url}`);
  console.log(`📡 Listening on port: ${port}`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`✅ Ready to accept connections`);
}

bootstrap().catch((error: unknown) => {
  const details = error instanceof Error ? error.stack || error.message : String(error);
  console.error('Falha ao iniciar aplicacao Next Level:', details);
  process.exit(1);
});
