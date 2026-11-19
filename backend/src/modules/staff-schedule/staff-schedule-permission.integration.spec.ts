import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaClient, type Role } from '@prisma/client';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { deployMigrations } from '../../../test/migrations';
import { AuditRepository } from '../../shared/audit/audit.repository';
import { AuditService } from '../../shared/audit/audit.service';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RolesGuard } from '../auth/roles.guard';
import { PermissionsRepository } from '../permissions/permissions.repository';
import { PermissionsService } from '../permissions/permissions.service';
import { StaffScheduleController } from './staff-schedule.controller';

let postgres: StartedPostgreSqlContainer;
let prisma: PrismaClient;
let permissionsGuard: PermissionsGuard;
const reflector = new Reflector();
const rolesGuard = new RolesGuard(reflector);

beforeAll(async () => {
  postgres = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('orgamind_test')
    .withUsername('orgamind')
    .withPassword('orgamind')
    .start();
  const databaseUrl = postgres.getConnectionUri();
  deployMigrations({ databaseUrl });
  prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  // Serviço e guard de verdade sobre o banco de verdade (sem cache entre chamadas).
  const audit = new AuditService(new AuditRepository(prisma as never), {
    get: () => undefined,
  } as never);
  const permissions = new PermissionsService(
    prisma as never,
    new PermissionsRepository(prisma as never),
    audit,
  );
  permissionsGuard = new PermissionsGuard(reflector, permissions);
}, 180_000);

afterAll(async () => {
  await prisma?.$disconnect();
  await postgres?.stop();
});

const handlerOf = (name: keyof StaffScheduleController) =>
  StaffScheduleController.prototype[name];

/** Contexto do handler `PUT users/:userId/schedule`. */
function putScheduleAs(role: Role): ExecutionContext {
  return {
    getHandler: () => handlerOf('putSchedule'),
    getClass: () => StaffScheduleController,
    switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
  } as unknown as ExecutionContext;
}

async function evaluate(role: Role): Promise<boolean> {
  const ctx = putScheduleAs(role);
  return (
    rolesGuard.canActivate(ctx) && (await permissionsGuard.canActivate(ctx))
  );
}

function setGranted(granted: boolean): Promise<unknown> {
  return prisma.rolePermission.update({
    where: { role_key: { role: 'OPERATOR', key: 'escala.alterar' } },
    data: { granted },
  });
}

describe('escala.alterar no portão da escala (aceite 11, banco real)', () => {
  it('OPERATOR passa; desmarcar escala.alterar dá 403 na avaliação seguinte; marcar de novo devolve', async () => {
    const before = await evaluate('OPERATOR');
    await setGranted(false);
    const revoked = evaluate('OPERATOR');
    await expect(revoked).rejects.toMatchObject({
      status: 403,
      code: 'auth.permission_denied',
    });
    await setGranted(true);
    const restored = await evaluate('OPERATOR');

    expect([before, restored]).toEqual([true, true]);
  });
});
