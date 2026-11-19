import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Role } from '@prisma/client';
import { ForbiddenError } from '../../shared/errors/domain.error';
import { ROLES_KEY } from './decorators/roles.decorator';
import { IS_PUBLIC_KEY } from './decorators/public.decorator';
import { PERMISSION_KEY } from './decorators/require-permission.decorator';

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

  /**
   * Precedência (DB3): `@RequirePermission` no handler cala o `@Roles`; na
   * classe, só se o handler não tiver `@Roles` (o do handler vale). Quem
   * confere a permissão é o `PermissionsGuard`, depois deste.
   */
  private deferredToPermission(context: ExecutionContext): boolean {
    const handler = [context.getHandler()];
    const onHandler = this.reflector.getAllAndOverride<unknown>(
      PERMISSION_KEY,
      handler,
    );
    if (onHandler !== undefined) return true;
    const onClass = this.reflector.getAllAndOverride<unknown>(PERMISSION_KEY, [
      context.getClass(),
    ]);
    if (onClass === undefined) return false;
    const rolesOnHandler = this.reflector.getAllAndOverride<unknown>(
      ROLES_KEY,
      handler,
    );
    return rolesOnHandler === undefined;
  }

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;
    if (this.deferredToPermission(context)) return true;
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
