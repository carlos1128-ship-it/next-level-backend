import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/http-exception.filter';

const logger = new Logger('Bootstrap');

function parseAllowedOrigins(): string[] {
  const raw = process.env.CORS_ORIGINS ?? process.env.FRONTEND_URL ?? '';
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function logRegisteredRoutes(app: any): void {
  const instance = app.getHttpAdapter().getInstance();
  const routes: string[] = [];

  const readStack = (stack: any[], prefix = ''): void => {
    for (const layer of stack) {
      if (layer.route?.path) {
        const methods = Object.keys(layer.route.methods || {})
          .map((method) => method.toUpperCase())
          .join(',');
        routes.push(`${methods} ${prefix}${layer.route.path}`);
        continue;
      }

      if (layer.name === 'router' && layer.handle?.stack) {
        const pathMatch = layer.regexp?.toString().match(/\\\/(.*?)\\\/\?\(\?=\\\/\|\$\)/);
        const rawPath = pathMatch?.[1]?.replace(/\\\//g, '/') ?? '';
        readStack(layer.handle.stack, `${prefix}/${rawPath}`);
      }
    }
  };

  if (instance?._router?.stack) {
    readStack(instance._router.stack);
  }

  if (routes.length === 0) {
    logger.warn('Nenhuma rota detectada para log automatico');
    return;
  }

  logger.log(`Rotas registradas (${routes.length}):`);
  routes.sort().forEach((route) => logger.log(`  ${route}`));
}

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const allowedOrigins = parseAllowedOrigins();

  if (!process.env.DATABASE_URL) {
    logger.error('DATABASE_URL nao configurada. Defina no Render para o backend iniciar corretamente.');
  }

  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (req.url.startsWith('/api/api/')) {
      req.url = req.url.replace('/api/api/', '/api/');
    }
    console.log('Rota acessada:', req.method, req.originalUrl);
    next();
  });

  app.enableCors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      logger.warn(`CORS bloqueado para origem: ${origin}`);
      return callback(new Error('Not allowed by CORS'));
    },
    credentials: true,
  });

  app.useGlobalFilters(new AllExceptionsFilter());
  app.setGlobalPrefix('api');
  await app.init();
  logRegisteredRoutes(app);

  logger.log(
    `Servidor iniciado em modo ${process.env.NODE_ENV || 'development'} na porta ${process.env.PORT || 3000}`,
  );

  await app.listen(process.env.PORT || 3000);
}

bootstrap();
