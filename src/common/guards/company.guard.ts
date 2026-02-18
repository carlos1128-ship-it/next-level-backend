import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';

/**
 * Garante que o company_id do token JWT seja o único usado.
 * Nenhuma rota pode acessar dados de outra empresa.
 */
@Injectable()
export class CompanyGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const user = request.user as { companyId?: string } | undefined;
    const bodyCompanyId = (request.body as { company_id?: string })?.company_id;
    const queryCompanyId = request.query?.company_id as string | undefined;

    const tokenCompanyId = user?.companyId;
    if (!tokenCompanyId) return true;

    if (bodyCompanyId && bodyCompanyId !== tokenCompanyId) {
      throw new ForbiddenException('Acesso negado: company_id não corresponde ao token');
    }
    if (queryCompanyId && queryCompanyId !== tokenCompanyId) {
      throw new ForbiddenException('Acesso negado: company_id não corresponde ao token');
    }

    return true;
  }
}
