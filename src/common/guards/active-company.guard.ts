import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
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
  private readonly logger = new Logger(ActiveCompanyGuard.name);

  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const user = request.user;

    if (!user?.id && !user?.userId) {
      throw new ForbiddenException('Usuario nao autenticado');
    }

    const userId = user.id || user.userId || '';
    const resolution = this.resolveCompanyId(request, Boolean(user.admin));
    const companyId = resolution.resolvedCompanyId;
    if (!companyId) {
      await this.logCompanyResolutionIssue(
        'missing_company_id',
        request,
        userId,
        resolution,
      );
      throw new BadRequestException('companyId nao informado');
    }

    if (user.admin) {
      this.applyResolvedCompany(request, companyId);
      return true;
    }

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
      await this.logCompanyResolutionIssue(
        'membership_not_found',
        request,
        userId,
        resolution,
      );
      throw new ForbiddenException('Sem acesso a empresa informada');
    }

    this.applyResolvedCompany(request, companyId);

    return true;
  }

  private resolveCompanyId(request: AuthenticatedRequest, _isAdmin: boolean) {
    const queryCompanyId = this.asString(request.query?.companyId);
    const bodyCompanyId = this.asString(
      (request.body as { companyId?: unknown } | undefined)?.companyId,
    );
    const paramCompanyId = this.asString(request.params?.companyId);
    const userCompanyId = this.asString(request.user?.companyId);
    const requestedCompanyId = queryCompanyId || bodyCompanyId || paramCompanyId;
    const resolvedCompanyId = requestedCompanyId || userCompanyId;

    return {
      requestedCompanyId,
      resolvedCompanyId,
      userCompanyId,
    };
  }

  private applyResolvedCompany(request: AuthenticatedRequest, companyId: string) {
    request.query.companyId = companyId;
    if (request.body && typeof request.body === 'object') {
      (request.body as Record<string, unknown>).companyId = companyId;
    }
    if (request.user) {
      request.user.companyId = companyId;
    }
  }

  private async logCompanyResolutionIssue(
    reason: string,
    request: AuthenticatedRequest,
    userId: string,
    resolution: {
      requestedCompanyId: string;
      resolvedCompanyId: string;
      userCompanyId: string;
    },
  ) {
    const availableCompanyIdsCount = userId
      ? await this.prisma.company.count({
          where: {
            OR: [{ userId }, { users: { some: { id: userId } } }],
          },
        })
      : 0;

    this.logger.warn(
      JSON.stringify({
        reason,
        userId,
        requestedCompanyId: resolution.requestedCompanyId || null,
        resolvedCompanyId: resolution.resolvedCompanyId || null,
        userCompanyId: resolution.userCompanyId || null,
        availableCompanyIdsCount,
        routePath: request.path || request.originalUrl || request.url,
      }),
    );
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
