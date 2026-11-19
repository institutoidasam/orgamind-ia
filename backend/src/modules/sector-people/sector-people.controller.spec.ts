import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { SectorPeopleController } from './sector-people.controller';
import type { SectorPeopleService } from './sector-people.service';
import type { SectorPeopleWriteService } from './sector-people-write.service';

const HANDLERS = [
  'list',
  'candidates',
  'contactCandidates',
  'create',
  'addFromContacts',
  'move',
  'update',
  'remove',
  'setStatus',
] as const;
type Handler = (typeof HANDLERS)[number];

function context(handler: Handler, role: string) {
  return {
    getHandler: () => SectorPeopleController.prototype[handler],
    getClass: () => SectorPeopleController,
    switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
  } as unknown as ExecutionContext;
}

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

describe('SectorPeopleController — autorização', () => {
  it.each(HANDLERS)('%s: papel de escrita passa, VIEWER → 403', (handler) => {
    const reflector = new Reflector();
    const guard = new RolesGuard(reflector);

    expect(
      reflector.get(ROLES_KEY, SectorPeopleController.prototype[handler]),
    ).toBeUndefined();
    expect(() => guard.canActivate(context(handler, 'VIEWER'))).toThrow(
      expect.objectContaining({ status: 403, code: 'auth.insufficient_role' }),
    );
    for (const role of ['ADMIN', 'SUPERVISOR', 'OPERATOR']) {
      expect(guard.canActivate(context(handler, role))).toBe(true);
    }
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
