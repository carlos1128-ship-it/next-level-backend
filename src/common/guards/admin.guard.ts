import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';

@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const isAdmin = Boolean(request.user?.admin);

    if (!isAdmin) {
      throw new ForbiddenException('Acesso restrito ao super admin');
    }

    return true;
  }
}
