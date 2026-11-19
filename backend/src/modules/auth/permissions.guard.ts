import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Role } from '@prisma/client';
import {
  permissionDenied,
  type PermissionKey,
} from '../../shared/authz/permissions';
import { PermissionsService } from '../permissions/permissions.service';
import { IS_PUBLIC_KEY } from './decorators/public.decorator';
import { PERMISSION_KEY } from './decorators/require-permission.decorator';

/**
 * Portão por ação (DB3), depois do `RolesGuard`. Só age em rota marcada com
 * `@RequirePermission` (handler vale sobre classe); lê a matriz do banco a cada
 * requisição. Sem usuário na requisição, nega: o `RolesGuard` não confere papel
 * em rota com permissão, então este guard é quem fecha a rota.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly permissions: PermissionsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) {
      return true;
    }
    const key = this.reflector.getAllAndOverride<PermissionKey | undefined>(
      PERMISSION_KEY,
      targets,
    );
    if (key === undefined) return true;
    const req = context.switchToHttp().getRequest<{ user?: { role?: Role } }>();
    const role = req.user?.role;
    if (!role) throw permissionDenied(key);
    const granted = await this.permissions.effectiveFor(role);
    if (!granted.includes(key)) throw permissionDenied(key);
    return true;
  }
}
