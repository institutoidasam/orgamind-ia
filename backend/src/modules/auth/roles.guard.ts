import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Role } from '@prisma/client';
import { ForbiddenError } from '../../shared/errors/domain.error';
import { ROLES_KEY } from './decorators/roles.decorator';
import { IS_PUBLIC_KEY } from './decorators/public.decorator';

function hasLegacyRole(role: Role | undefined): boolean {
  return role === 'ADMIN' || role === 'OPERATOR';
}

function canUseRoute(
  required: Role[] | undefined,
  role: Role | undefined,
): boolean {
  return required?.length
    ? required.includes(role as Role)
    : hasLegacyRole(role);
}

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;
    const required = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const req = context.switchToHttp().getRequest<{ user?: { role?: Role } }>();
    const user = req.user;
    if (!canUseRoute(required, user?.role)) {
      throw new ForbiddenError(
        required?.length
          ? `Requires role: ${required.join(' or ')}`
          : 'This route requires an explicit role grant',
        'auth.insufficient_role',
      );
    }
    return true;
  }
}
