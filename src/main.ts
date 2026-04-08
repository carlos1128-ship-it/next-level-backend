import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { RequestMethod } from '@nestjs/common';
import { Request, Response } from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { AppModule } from './app.module';
import { ZodValidationPipe } from './common/pipes/zod-validation.pipe';

function parseAllowedOrigins(raw: string | undefined): Set<string> {
  const defaults = [
    'http://localhost:3000',
    'http://localhost:5173',
    'https://next-level-front.vercel.app',
  ];

  const envOrigins = (raw || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  return new Set([...defaults, ...envOrigins]);
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
  const app = await NestFactory.create(AppModule);
  const allowedOrigins = parseAllowedOrigins(process.env.CORS_ORIGINS);
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
    exclude: [{ path: 'webhook/whatsapp', method: RequestMethod.POST }],
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
    }),
  );

  app.enableCors({
    origin: (origin, callback) => {
      if (!origin) {
        callback(null, true);
        return;
      }

      if (allowedOrigins.has(origin) || isAllowedVercelPreview(origin)) {
        callback(null, true);
        return;
      }

      callback(new Error(`CORS blocked for origin: ${origin}`), false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  const port = process.env.PORT || 3333;
  await app.listen(port, '0.0.0.0');
  const url = await app.getUrl();
  console.log(`🚀 Application is running on: ${url}`);
  console.log(`📡 Listening on port: ${port}`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`✅ Ready to accept connections`);
}
bootstrap();
