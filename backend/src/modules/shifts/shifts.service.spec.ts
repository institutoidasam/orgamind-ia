import { Prisma } from '@prisma/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ShiftRow } from './shifts.repository';
import { ShiftsService } from './shifts.service';

const FIRST: ShiftRow = {
  id: 'shift_first',
  name: '1º turno',
  startTime: '06:00',
  endTime: '14:00',
  isActive: true,
  sortOrder: 1,
};
const NIGHT: ShiftRow = {
  id: 'shift_night',
  name: 'Noite',
  startTime: '22:00',
  endTime: '06:00',
  isActive: true,
  sortOrder: 2,
};
const ACTOR = 'admin-1';

// Repositório em memória: a comparação sem caixa é do repositório (integração);
// aqui ela não apara espaços, para provar que o serviço apara antes de consultar.
function harness(rows: ShiftRow[] = [FIRST, NIGHT]) {
  const byId = (id: string) => rows.find((r) => r.id === id);
  const byName = (name: string, exceptId?: string) =>
    rows.find(
      (r) => r.id !== exceptId && r.name.toLowerCase() === name.toLowerCase(),
    ) ?? null;
  const repo = {
    listAll: vi.fn().mockResolvedValue(rows),
    findById: vi.fn((id: string) => Promise.resolve(byId(id) ?? null)),
    findByNameInsensitive: vi.fn((name: string, exceptId?: string) =>
      Promise.resolve(byName(name, exceptId)),
    ),
    usage: vi.fn().mockResolvedValue(new Map()),
    maxSortOrder: vi.fn().mockResolvedValue(2),
    create: vi.fn((data: object) =>
      Promise.resolve({ id: 'shift_new', isActive: true, ...data }),
    ),
    update: vi.fn((id: string, data: object) =>
      Promise.resolve({ ...byId(id), ...data }),
    ),
    setOrder: vi.fn().mockResolvedValue(undefined),
  };
  const audit = { log: vi.fn().mockResolvedValue(undefined) };
  const service = new ShiftsService(repo as never, audit as never);
  return { repo, audit, service };
}

describe('ShiftsService.create', () => {
  it("cria 'Noite' 22:00–06:00 com sortOrder = maior + 1 e crossesMidnight true", async () => {
    const { repo, audit, service } = harness([FIRST]);
    repo.maxSortOrder.mockResolvedValue(7);

    const created = await service.create(ACTOR, {
      name: 'Noite',
      startTime: '22:00',
      endTime: '06:00',
    });

    expect(repo.create).toHaveBeenCalledWith({
      name: 'Noite',
      startTime: '22:00',
      endTime: '06:00',
      sortOrder: 8,
    });
    expect(created).toEqual({
      id: 'shift_new',
      name: 'Noite',
      startTime: '22:00',
      endTime: '06:00',
      isActive: true,
      sortOrder: 8,
      crossesMidnight: true,
      inUse: [],
    });
    expect(audit.log).toHaveBeenCalledWith(
      'shift.create',
      'Shift',
      'shift_new',
      {
        actorId: ACTOR,
        shiftId: 'shift_new',
      },
    );
  });
});

describe('ShiftsService.create — nome único', () => {
  it.each(['noite', ' Noite '])(
    'nome repetido %j → 409 shifts.name_taken',
    async (name) => {
      const { repo, service } = harness();
      await expect(
        service.create(ACTOR, { name, startTime: '22:00', endTime: '06:00' }),
      ).rejects.toMatchObject({ status: 409, code: 'shifts.name_taken' });
      expect(repo.create).not.toHaveBeenCalled();
    },
  );

  it('corrida no nome único do banco (P2002) → 409 shifts.name_taken', async () => {
    const { repo, service } = harness([FIRST]);
    repo.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );
    await expect(
      service.create(ACTOR, {
        name: 'Tarde',
        startTime: '13:00',
        endTime: '19:00',
      }),
    ).rejects.toMatchObject({ status: 409, code: 'shifts.name_taken' });
  });
});

describe('ShiftsService.update — desativar', () => {
  it('desativar turno em uso → 409 shifts.in_use e não grava', async () => {
    const { repo, audit, service } = harness();
    repo.usage.mockResolvedValue(
      new Map([['shift_first', [{ kind: 'users', count: 2 }]]]),
    );
    await expect(
      service.update(ACTOR, 'shift_first', { isActive: false }),
    ).rejects.toMatchObject({ status: 409, code: 'shifts.in_use' });
    expect(repo.update).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('desativar sem uso → isActive false e auditoria', async () => {
    const { repo, audit, service } = harness();
    const updated = await service.update(ACTOR, 'shift_first', {
      isActive: false,
    });
    expect(updated).toMatchObject({ id: 'shift_first', isActive: false });
    expect(repo.update).toHaveBeenCalledWith('shift_first', {
      isActive: false,
    });
    expect(audit.log).toHaveBeenCalledWith(
      'shift.update',
      'Shift',
      'shift_first',
      { actorId: ACTOR, shiftId: 'shift_first' },
    );
  });
});

describe('ShiftsService.update — edição', () => {
  it('mudar horário só atualiza o Shift', async () => {
    const { repo, service } = harness();
    const updated = await service.update(ACTOR, 'shift_night', {
      startTime: '21:00',
    });
    expect(repo.update).toHaveBeenCalledTimes(1);
    expect(repo.update).toHaveBeenCalledWith('shift_night', {
      startTime: '21:00',
    });
    expect(repo.create).not.toHaveBeenCalled();
    expect(repo.setOrder).not.toHaveBeenCalled();
    expect(updated).toMatchObject({
      startTime: '21:00',
      crossesMidnight: true,
    });
  });

  it('id inexistente → 404 shifts.not_found', async () => {
    const { repo, service } = harness();
    await expect(
      service.update(ACTOR, 'shift_missing', { name: 'Madrugada' }),
    ).rejects.toMatchObject({ status: 404, code: 'shifts.not_found' });
    expect(repo.update).not.toHaveBeenCalled();
  });
});

describe('ShiftsService.reorder', () => {
  it.each([
    ['faltando', ['shift_first']],
    ['sobrando', ['shift_first', 'shift_night', 'shift_other']],
    ['repetido', ['shift_first', 'shift_first']],
  ])(
    'reordenar com conjunto diferente (%s) → 422 shifts.invalid_order',
    async (_case, ids) => {
      const { repo, audit, service } = harness();
      await expect(service.reorder(ACTOR, { ids })).rejects.toMatchObject({
        status: 422,
        code: 'shifts.invalid_order',
      });
      expect(repo.setOrder).not.toHaveBeenCalled();
      expect(audit.log).not.toHaveBeenCalled();
    },
  );

  it('reordenar grava 1..n na ordem recebida', async () => {
    const { repo, audit, service } = harness();
    const ids = ['shift_night', 'shift_first'];

    const result = await service.reorder(ACTOR, { ids });

    expect(repo.setOrder).toHaveBeenCalledWith(ids);
    expect(audit.log).toHaveBeenCalledWith(
      'shift.reorder',
      'Shift',
      undefined,
      {
        actorId: ACTOR,
        shiftIds: ids,
      },
    );
    expect(result.items).toHaveLength(2);
  });
});

describe('ShiftsService.list', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('list devolve inUse só com count > 0', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // 22:30 de 21/10 em Manaus (UTC−4) já é 22/10 em UTC.
    vi.setSystemTime(new Date('2026-10-22T02:30:00.000Z'));
    const { repo, service } = harness();
    repo.usage.mockResolvedValue(
      new Map([
        [
          'shift_first',
          [
            { kind: 'users', count: 0 },
            { kind: 'schedules', count: 3 },
          ],
        ],
      ]),
    );

    const { items } = await service.list();

    expect(repo.usage).toHaveBeenCalledWith(
      ['shift_first', 'shift_night'],
      '2026-10-21',
    );
    expect(items.map((s) => [s.id, s.inUse, s.crossesMidnight])).toEqual([
      ['shift_first', [{ kind: 'schedules', count: 3 }], false],
      ['shift_night', [], true],
    ]);
  });
});
