import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { Request } from 'express';

@Injectable()
export class ActiveCompanyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const user = request.user as { companyId?: string | null } | undefined;
    const queryCompanyId = this.asString(request.query?.companyId);
    const bodyCompanyId = this.asString((request.body as { companyId?: unknown } | undefined)?.companyId);
    const paramCompanyId = this.asString(request.params?.companyId);
    const companyId =
      user?.companyId?.trim() || queryCompanyId || bodyCompanyId || paramCompanyId;

    if (!companyId) {
      throw new BadRequestException('companyId nao informado');
    }

    return true;
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
