import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Role } from '@prisma/client';
import { ForbiddenError } from '../../shared/errors/domain.error';
import { ROLES_KEY } from './decorators/roles.decorator';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const req = context.switchToHttp().getRequest();
    const user = req.user as { role?: Role } | undefined;
    if (!user?.role || !required.includes(user.role)) {
      throw new ForbiddenError(
        `Requires role: ${required.join(' or ')}`,
        'auth.insufficient_role',
      );
    }
    return true;
  }
}
