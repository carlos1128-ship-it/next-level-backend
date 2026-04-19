import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Request } from 'express';
import { PrismaService } from '../../prisma/prisma.service';

type AuthenticatedRequest = Request & {
  user?: {
    userId?: string;
    id?: string;
    admin?: boolean;
    companyId?: string | null;
  };
};

@Injectable()
export class ActiveCompanyGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const user = request.user;

    if (!user?.id && !user?.userId) {
      throw new ForbiddenException('Usuario nao autenticado');
    }

    const companyId = this.resolveCompanyId(request);
    if (!companyId) {
      throw new BadRequestException('companyId nao informado');
    }

    if (user.admin) {
      request.query.companyId = companyId;
      if (request.body && typeof request.body === 'object') {
        (request.body as Record<string, unknown>).companyId = companyId;
      }
      return true;
    }

    const userId = user.id || user.userId || '';
    const company = await this.prisma.company.findFirst({
      where: {
        id: companyId,
        OR: [
          { userId },
          { users: { some: { id: userId } } },
        ],
      },
      select: { id: true },
    });

    if (!company) {
      throw new ForbiddenException('Sem acesso a empresa informada');
    }

    request.query.companyId = companyId;
    if (request.body && typeof request.body === 'object') {
      (request.body as Record<string, unknown>).companyId = companyId;
    }

    return true;
  }

  private resolveCompanyId(request: AuthenticatedRequest): string {
    const queryCompanyId = this.asString(request.query?.companyId);
    const bodyCompanyId = this.asString(
      (request.body as { companyId?: unknown } | undefined)?.companyId,
    );
    const paramCompanyId = this.asString(request.params?.companyId);
    const userCompanyId = this.asString(request.user?.companyId);

    return queryCompanyId || bodyCompanyId || paramCompanyId || userCompanyId;
  }

  private asString(value: unknown): string {
    if (Array.isArray(value)) {
      const first = value.find((item) => typeof item === 'string' && item.trim());
      return typeof first === 'string' ? first.trim() : '';
    }
    if (typeof value === 'string') {
      return value.trim();
    }
    return '';
  }
}
