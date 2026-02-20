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
    const companyId = user?.companyId?.trim();

    console.log('companyId recebido:', companyId);

    if (!companyId) {
      throw new BadRequestException('companyId nao informado');
    }

    return true;
  }
}
