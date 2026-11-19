import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Role } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { PERMISSION_KEY } from '../auth/decorators/require-permission.decorator';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RolesGuard } from '../auth/roles.guard';
import type { PermissionsService } from '../permissions/permissions.service';
import {
  permissionsWith,
  type PermissionChange,
} from '../../shared/authz/actor.test-fixtures';
import { PERMISSION_DENIED_TEXT } from '../../shared/authz/permissions';
import { StaffScheduleController } from './staff-schedule.controller';

type Handler = keyof StaffScheduleController;
const READS: Handler[] = ['options', 'board'];
const WRITES: Handler[] = [
  'putSchedule',
  'deleteSchedule',
  'createException',
  'deleteException',
];
const ASO: Role[] = ['ADMIN', 'SUPERVISOR', 'OPERATOR'];
const PERMISSION_DENIED = {
  status: 403,
  code: 'auth.permission_denied',
  detail: PERMISSION_DENIED_TEXT['escala.alterar'],
};

function context(handler: Handler, role: Role) {
  return {
    getHandler: () => StaffScheduleController.prototype[handler],
    getClass: () => StaffScheduleController,
    switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
  } as unknown as ExecutionContext;
}

/** Cadeia do app: `RolesGuard`, depois `PermissionsGuard`; `change` ajusta a matriz do papel. */
async function passesGuards(
  handler: Handler,
  role: Role,
  change: PermissionChange = {},
) {
  const reflector = new Reflector();
  const permissions = {
    effectiveFor: (r: Role) => Promise.resolve(permissionsWith(r, change)),
  } as unknown as PermissionsService;
  const ctx = context(handler, role);
  return (
    new RolesGuard(reflector).canActivate(ctx) &&
    (await new PermissionsGuard(reflector, permissions).canActivate(ctx))
  );
}

describe('StaffScheduleController — metadados por handler', () => {
  it('sem @Roles na classe: leituras por @Roles A,S,O no handler, escritas por @RequirePermission("escala.alterar") sem @Roles', () => {
    const reflector = new Reflector();
    const route = (name: Handler) => StaffScheduleController.prototype[name];

    expect(reflector.get(ROLES_KEY, StaffScheduleController)).toBeUndefined();
    expect(
      reflector.get(PERMISSION_KEY, StaffScheduleController),
    ).toBeUndefined();
    for (const name of READS) {
      expect(reflector.get(ROLES_KEY, route(name))).toEqual(ASO);
      expect(reflector.get(PERMISSION_KEY, route(name))).toBeUndefined();
    }
    for (const name of WRITES) {
      expect(reflector.get(PERMISSION_KEY, route(name))).toBe('escala.alterar');
      expect(reflector.get(ROLES_KEY, route(name))).toBeUndefined();
    }
  });
});

describe('StaffScheduleController — autorização', () => {
  it('escritas, matriz inicial: ADMIN, SUPERVISOR e OPERATOR passam; VIEWER recebe 403 auth.permission_denied', async () => {
    for (const handler of WRITES) {
      for (const role of ASO) {
        await expect(passesGuards(handler, role)).resolves.toBe(true);
      }
      await expect(passesGuards(handler, 'VIEWER')).rejects.toMatchObject(
        PERMISSION_DENIED,
      );
    }
  });

  it('escritas: OPERATOR sem escala.alterar recebe 403 auth.permission_denied', async () => {
    const revoke: PermissionChange = { revoke: ['escala.alterar'] };

    for (const handler of WRITES) {
      await expect(
        passesGuards(handler, 'OPERATOR', revoke),
      ).rejects.toMatchObject(PERMISSION_DENIED);
    }
  });

  it('leituras seguem por papel: A,S,O passam mesmo sem a chave; VIEWER recebe 403 auth.insufficient_role', async () => {
    const revoke: PermissionChange = { revoke: ['escala.alterar'] };

    for (const handler of READS) {
      for (const role of ASO) {
        await expect(passesGuards(handler, role, revoke)).resolves.toBe(true);
      }
      await expect(passesGuards(handler, 'VIEWER')).rejects.toMatchObject({
        status: 403,
        code: 'auth.insufficient_role',
      });
    }
  });
});
