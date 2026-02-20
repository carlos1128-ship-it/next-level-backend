import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/http-exception.filter';

const logger = new Logger('Bootstrap');
const vercelPreviewRegex =
  /^https:\/\/next-level-front(?:-[a-z0-9-]+)?(?:-carlos1128-ship-its-projects)?\.vercel\.app$/i;

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

  if (!process.env.DATABASE_URL) {
    logger.error('DATABASE_URL nao configurada. Defina no Render para o backend iniciar corretamente.');
  }

  app.setGlobalPrefix('api');

  app.getHttpAdapter().get('/', (_req, res) => {
    res.status(200).json({ status: 'ok', service: 'next-level-backend' });
  });

  app.enableCors({
    origin: [
      'http://localhost:3000',
      'https://next-level-front.vercel.app',
      vercelPreviewRegex,
    ],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    optionsSuccessStatus: 204,
  });

  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  logRegisteredRoutes(app);

  logger.log(
    `Servidor iniciado em modo ${process.env.NODE_ENV || 'development'} na porta ${process.env.PORT || 3000}`,
  );

  await app.listen(process.env.PORT || 3000);
}

bootstrap();
