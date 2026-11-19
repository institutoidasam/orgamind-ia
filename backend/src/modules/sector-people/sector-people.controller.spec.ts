import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Role } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RolesGuard } from '../auth/roles.guard';
import type { PermissionsService } from '../permissions/permissions.service';
import {
  permissionsWith,
  type PermissionChange,
} from '../../shared/authz/actor.test-fixtures';
import { SectorPeopleController } from './sector-people.controller';
import type { SectorPeopleService } from './sector-people.service';
import type { SectorPeopleWriteService } from './sector-people-write.service';

const READS = ['list', 'candidates', 'contactCandidates'] as const;
const EDITS = [
  'create',
  'addFromContacts',
  'move',
  'update',
  'remove',
] as const;
type Handler = (typeof READS)[number] | (typeof EDITS)[number] | 'setStatus';

const ASO: Role[] = ['ADMIN', 'SUPERVISOR', 'OPERATOR'];
const DENIED = { status: 403, code: 'auth.permission_denied' };

function context(handler: Handler, role: Role) {
  return {
    getHandler: () => SectorPeopleController.prototype[handler],
    getClass: () => SectorPeopleController,
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

describe('SectorPeopleController — leituras por papel', () => {
  it('as três leituras têm @Roles A,S,O no handler e a classe não tem @Roles', () => {
    const reflector = new Reflector();

    expect(reflector.get(ROLES_KEY, SectorPeopleController)).toBeUndefined();
    for (const handler of READS) {
      expect(
        reflector.get(ROLES_KEY, SectorPeopleController.prototype[handler]),
      ).toEqual(ASO);
    }
  });

  it.each(READS)(
    '%s: A, S, O passam; VIEWER → 403 insufficient_role',
    async (handler) => {
      for (const role of ASO) {
        await expect(passesGuards(handler, role)).resolves.toBe(true);
      }
      await expect(passesGuards(handler, 'VIEWER')).rejects.toMatchObject({
        status: 403,
        code: 'auth.insufficient_role',
      });
    },
  );
});

describe('SectorPeopleController — escritas por pessoas.editar', () => {
  it.each(EDITS)(
    '%s: matriz inicial mantém A, S, O e nega o VIEWER',
    async (handler) => {
      for (const role of ASO) {
        await expect(passesGuards(handler, role)).resolves.toBe(true);
      }
      await expect(passesGuards(handler, 'VIEWER')).rejects.toMatchObject(
        DENIED,
      );
    },
  );

  it.each(EDITS)(
    '%s: sem pessoas.editar → 403; perder outra chave não nega',
    async (handler) => {
      const semEditar = { revoke: ['pessoas.editar'] } as const;
      const semInativar = { revoke: ['pessoas.inativar'] } as const;

      await expect(
        passesGuards(handler, 'OPERATOR', semEditar),
      ).rejects.toMatchObject(DENIED);
      await expect(
        passesGuards(handler, 'SUPERVISOR', semEditar),
      ).rejects.toMatchObject(DENIED);
      await expect(
        passesGuards(handler, 'SUPERVISOR', semInativar),
      ).resolves.toBe(true);
    },
  );
});

describe('SectorPeopleController — inativação por pessoas.inativar', () => {
  it('matriz inicial: A e S passam; O e VIEWER → 403 permission_denied', async () => {
    for (const role of ['ADMIN', 'SUPERVISOR'] as const) {
      await expect(passesGuards('setStatus', role)).resolves.toBe(true);
    }
    for (const role of ['OPERATOR', 'VIEWER'] as const) {
      await expect(passesGuards('setStatus', role)).rejects.toMatchObject(
        DENIED,
      );
    }
  });

  it('a chave decide: O com pessoas.inativar concedida passa; S sem ela, 403', async () => {
    const concedida = { grant: ['pessoas.inativar'] } as const;
    const revogada = { revoke: ['pessoas.inativar'] } as const;

    await expect(
      passesGuards('setStatus', 'OPERATOR', concedida),
    ).resolves.toBe(true);
    await expect(
      passesGuards('setStatus', 'SUPERVISOR', revogada),
    ).rejects.toMatchObject(DENIED);
  });
});

describe('SectorPeopleController — lista com inativos e status', () => {
  const req = { user: { sub: 'user_manager', role: 'SUPERVISOR' } } as never;

  it('list repassa includeInactive; setStatus encaminha ator, setor, pessoa e corpo', async () => {
    const people = { list: vi.fn().mockResolvedValue({}) };
    const write = { setStatus: vi.fn().mockResolvedValue({}) };
    const controller = new SectorPeopleController(
      people as unknown as SectorPeopleService,
      write as unknown as SectorPeopleWriteService,
    );
    const body = { isActive: false, reason: 'Desligamento' };

    await controller.list('sector_operation', { includeInactive: true }, req);
    await controller.setStatus('sector_operation', 'user_ana', body, req);

    expect(people.list).toHaveBeenCalledWith(
      'user_manager',
      'sector_operation',
      true,
    );
    expect(write.setStatus).toHaveBeenCalledWith(
      'user_manager',
      'sector_operation',
      'user_ana',
      body,
    );
  });
});

describe('SectorPeopleController — bindings', () => {
  it('encaminha ator, setor e busca ao serviço', async () => {
    const service = {
      list: vi.fn().mockResolvedValue({}),
      candidates: vi.fn().mockResolvedValue({ items: [] }),
      contactCandidates: vi.fn().mockResolvedValue({ items: [] }),
    };
    const controller = new SectorPeopleController(
      service as unknown as SectorPeopleService,
      {} as SectorPeopleWriteService,
    );
    const req = { user: { sub: 'user_manager', role: 'SUPERVISOR' } } as never;

    await controller.list('sector_operation', { includeInactive: false }, req);
    await controller.candidates('sector_operation', { q: 'ana' }, req);
    await controller.contactCandidates('sector_operation', { q: '9299' }, req);

    expect(service.list).toHaveBeenCalledWith(
      'user_manager',
      'sector_operation',
      false,
    );
    expect(service.candidates).toHaveBeenCalledWith(
      'user_manager',
      'sector_operation',
      'ana',
    );
    expect(service.contactCandidates).toHaveBeenCalledWith(
      'user_manager',
      'sector_operation',
      '9299',
    );
  });
});

function writeServiceStub() {
  return {
    create: vi.fn(),
    addFromContacts: vi.fn(),
    move: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
  };
}

describe('SectorPeopleController — bindings de escrita', () => {
  it('encaminha ator, setor, pessoa e body ao serviço de escrita', async () => {
    const write = writeServiceStub();
    const controller = new SectorPeopleController(
      {} as SectorPeopleService,
      write as unknown as SectorPeopleWriteService,
    );
    const req = { user: { sub: 'user_manager', role: 'SUPERVISOR' } } as never;
    const sector = 'sector_operation';
    const person = { name: 'Rita', phone: '92991110001', shiftId: 'shift_1' };
    const batch = { contactIds: ['contact_1'], shiftId: 'shift_1' };

    await controller.create(sector, person, req);
    await controller.addFromContacts(sector, batch, req);
    const moveBody = { userIds: ['user_nina'], reason: 'Reforço' };
    const updateBody = { jobTitle: 'Aux', reason: 'Ajuste de função' };
    await controller.move(sector, moveBody, req);
    await controller.update(sector, 'user_ana', updateBody, req);
    await controller.remove(sector, 'user_ana', { reason: 'Desligada' }, req);

    expect(write.create).toHaveBeenCalledWith('user_manager', sector, person);
    expect(write.addFromContacts).toHaveBeenCalledWith(
      'user_manager',
      sector,
      batch,
    );
    expect(write.move).toHaveBeenCalledWith(
      'user_manager',
      sector,
      ['user_nina'],
      'Reforço',
    );
    expect(write.update).toHaveBeenCalledWith(
      'user_manager',
      sector,
      'user_ana',
      updateBody,
    );
    expect(write.remove).toHaveBeenCalledWith(
      'user_manager',
      sector,
      'user_ana',
      'Desligada',
    );
  });
});
