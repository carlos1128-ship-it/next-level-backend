import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { AppModule } from './app.module';

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

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const allowedOrigins = parseAllowedOrigins(process.env.CORS_ORIGINS);

  app.setGlobalPrefix('api');
  app.use(helmet());
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

  await app.listen(process.env.PORT || 3333);
}
bootstrap();
