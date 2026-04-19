import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { PrismaService } from '../../prisma/prisma.service';
import { ActorType } from '@prisma/client';

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(private readonly prisma: PrismaService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest();
    const method = request.method as string;
    const path = (request.originalUrl || request.url) as string;
    const isMutableMethod = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
    const shouldAudit =
      isMutableMethod &&
      (
        path.includes('/config') ||
        path.includes('/admin/quotas') ||
        path.includes('/attendant')
      );

    const companyId =
      request.user?.companyId ||
      request.body?.companyId ||
      request.query?.companyId ||
      null;
    const actorId = request.user?.id;

    return next.handle().pipe(
      tap(async (data) => {
        if (!shouldAudit) return;
        try {
          await this.prisma.auditTrail.create({
            data: {
              companyId: companyId || undefined,
              actorId: actorId || undefined,
              actorType: actorId ? ActorType.HUMAN : ActorType.SYSTEM,
              action: `${method} ${path}`,
              details: {
                body: this.maskSensitive(request.body),
                response: data,
              },
            },
          });
        } catch {
          // silêncio: auditoria não interrompe requisição
        }
      }),
    );
  }

  private maskSensitive(payload: any): any {
    const SENSITIVE = [
      'password',
      'accesstoken',
      'metaaccesstoken',
      'token',
      'api_key',
      'cvv',
      'secret',
      'webhooktoken',
      'authorization',
    ];
    if (!payload || typeof payload !== 'object') return payload;
    const clone: Record<string, any> = {};
    for (const [k, v] of Object.entries(payload)) {
      if (SENSITIVE.includes(k.toLowerCase())) {
        clone[k] = '***';
      } else if (typeof v === 'object') {
        clone[k] = this.maskSensitive(v);
      } else {
        clone[k] = v;
      }
    }
    return clone;
  }
}
