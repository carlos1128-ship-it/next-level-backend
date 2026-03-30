import { Injectable, NestMiddleware } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Request, Response, NextFunction } from 'express';
import { PrismaService } from '../../prisma/prisma.service';

const SENSITIVE_KEYS = [
  'password',
  'accesstoken',
  'refreshtoken',
  'token',
  'api_key',
  'cvv',
  'secret',
  'authorization',
  'cookie',
];

@Injectable()
export class LoggingMiddleware implements NestMiddleware {
  constructor(private readonly prisma: PrismaService) {}

  use(req: Request, res: Response, next: NextFunction) {
    const start = Date.now();
    const method = req.method;
    const path = req.originalUrl || req.url;
    const companyId = (req as any).user?.companyId || (req.query?.companyId as string) || null;

    res.on('finish', async () => {
      const responseTime = Date.now() - start;
      const statusCode = res.statusCode;
      const payload = this.maskPayload({
        body: req.body,
        query: req.query,
        headers: req.headers,
      }) as Prisma.InputJsonValue;

      try {
        await this.prisma.apiLog.create({
          data: {
            method,
            path,
            statusCode,
            responseTime,
            companyId: companyId || undefined,
            payload,
          },
        });
      } catch (error) {
        // Não interromper o fluxo principal por falha de log
      }
    });

    next();
  }

  private maskPayload(input: unknown): unknown {
    if (Array.isArray(input)) {
      return input.map((item) => this.maskPayload(item));
    }
    if (input && typeof input === 'object') {
      const clone: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(input)) {
        if (SENSITIVE_KEYS.includes(key.toLowerCase())) {
          clone[key] = '***';
        } else {
          clone[key] = this.maskPayload(value);
        }
      }
      return clone;
    }
    return input;
  }
}
