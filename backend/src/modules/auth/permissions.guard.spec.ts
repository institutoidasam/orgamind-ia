import { describe, it, expect, vi } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Role } from '@prisma/client';
import { PermissionsGuard } from './permissions.guard';
import { RequirePermission } from './decorators/require-permission.decorator';
import { Public } from './decorators/public.decorator';
import type { PermissionsService } from '../permissions/permissions.service';
import {
  PERMISSION_DENIED_TEXT,
  type PermissionKey,
} from '../../shared/authz/permissions';
import { DomainError } from '../../shared/errors/domain.error';

@RequirePermission('pessoas.editar')
class Marked {
  inherits() {}
  @RequirePermission('escala.alterar')
  overrides() {}
  @Public()
  open() {}
}

class Unmarked {
  plain() {}
}

function contextFor(
  controller: new () => object,
  handler: string,
  user: { role: Role } | undefined,
): ExecutionContext {
  const proto = controller.prototype as Record<string, () => void>;
  return {
    getClass: () => controller,
    getHandler: () => proto[handler],
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

function guardWith(effective: PermissionKey[]) {
  const effectiveFor = vi.fn<(role: Role) => Promise<PermissionKey[]>>(() =>
    Promise.resolve(effective),
  );
  const guard = new PermissionsGuard(new Reflector(), {
    effectiveFor,
  } as unknown as PermissionsService);
  return { guard, effectiveFor };
}

async function denial(promise: Promise<boolean>): Promise<DomainError> {
  const error: unknown = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(DomainError);
  return error as DomainError;
}

describe('PermissionsGuard', () => {
  it('sem metadado passa sem consultar a matriz', async () => {
    const { guard, effectiveFor } = guardWith([]);

    const ctx = contextFor(Unmarked, 'plain', { role: 'VIEWER' });

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(effectiveFor).not.toHaveBeenCalled();
  });

  it('@Public passa', async () => {
    const { guard, effectiveFor } = guardWith([]);

    const ctx = contextFor(Marked, 'open', undefined);

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(effectiveFor).not.toHaveBeenCalled();
  });

  it('com a chave passa; sem a chave lança 403 auth.permission_denied com o detail da chave', async () => {
    const ctx = contextFor(Marked, 'inherits', { role: 'SUPERVISOR' });
    const granted = guardWith(['pessoas.editar']);
    const revoked = guardWith(['escala.alterar']);

    await expect(granted.guard.canActivate(ctx)).resolves.toBe(true);
    const error = await denial(revoked.guard.canActivate(ctx));

    expect(granted.effectiveFor).toHaveBeenCalledWith('SUPERVISOR');
    expect(error.status).toBe(403);
    expect(error.code).toBe('auth.permission_denied');
    expect(error.detail).toBe(PERMISSION_DENIED_TEXT['pessoas.editar']);
  });
});

describe('PermissionsGuard: precedência e falha fechada', () => {
  it('metadado do handler vence o da classe', async () => {
    const ctx = contextFor(Marked, 'overrides', { role: 'OPERATOR' });
    const onlyClassKey = guardWith(['pessoas.editar']);
    const handlerKey = guardWith(['escala.alterar']);

    const error = await denial(onlyClassKey.guard.canActivate(ctx));

    expect(error.detail).toBe(PERMISSION_DENIED_TEXT['escala.alterar']);
    await expect(handlerKey.guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('rota com chave e sem usuário na requisição é negada (falha fechada)', async () => {
    const { guard, effectiveFor } = guardWith(['pessoas.editar']);

    const error = await denial(
      guard.canActivate(contextFor(Marked, 'inherits', undefined)),
    );

    expect(error.code).toBe('auth.permission_denied');
    expect(effectiveFor).not.toHaveBeenCalled();
  });
});
