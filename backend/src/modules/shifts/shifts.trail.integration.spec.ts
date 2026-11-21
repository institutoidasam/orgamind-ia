import { randomUUID } from 'node:crypto';
import { PrismaClient, type Prisma } from '@prisma/client';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { deployMigrations } from '../../../test/migrations';
import { AuditRepository } from '../../shared/audit/audit.repository';
import { AuditService } from '../../shared/audit/audit.service';
import { AuditTrailRepository } from '../audit-trail/audit-trail.repository';
import { AuditTrailService } from '../audit-trail/audit-trail.service';
import { ShiftsRepository } from './shifts.repository';
import { ShiftsService } from './shifts.service';

const ACTOR = 'admin-1';
const OTHER_ACTOR = 'admin-2';
const HOURS = { startTime: '08:00', endTime: '12:00' };

let postgres: StartedPostgreSqlContainer;
let prisma: PrismaClient;
let audit: AuditService;
let shifts: ShiftsService;
let trail: AuditTrailService;

beforeAll(async () => {
  postgres = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('database_test')
    .withUsername(`user_${randomUUID().replaceAll('-', '')}`)
    .withPassword(randomUUID())
    .start();
  // Pool folgado: o teste de concorrência mantém várias sessões abertas ao mesmo tempo.
  const databaseUrl = `${postgres.getConnectionUri()}?connection_limit=10`;
  deployMigrations({ databaseUrl });
  prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  audit = new AuditService(new AuditRepository(prisma as never), {
    get: () => undefined,
  } as never);
  shifts = new ShiftsService(new ShiftsRepository(prisma as never), audit);
  trail = new AuditTrailService(new AuditTrailRepository(prisma as never));
}, 180_000);

afterAll(async () => {
  await prisma?.$disconnect();
  await postgres?.stop();
});

function makeShift(name: string, actor = ACTOR) {
  return shifts.create(actor, { name, ...HOURS });
}

function eventsOf(where: Prisma.AuditEventWhereInput) {
  return prisma.auditEvent.findMany({
    where: { entity: 'Shift', ...where },
    orderBy: { createdAt: 'asc' },
    select: {
      action: true,
      category: true,
      actorId: true,
      entityId: true,
      changes: true,
    },
  });
}

function makeAdmin() {
  return prisma.user.create({
    data: {
      name: 'Admin Trilha',
      email: 'trilha@test.local',
      password: randomUUID(),
      role: 'ADMIN',
    },
  });
}

async function currentOrder() {
  const { items } = await shifts.list();
  return { ids: items.map((s) => s.id), names: items.map((s) => s.name) };
}

describe('Turnos — trilha da criação (aceite 16; Postgres exclusivo)', () => {
  it('aceite 16: criar turno grava shift.create com os valores iniciais, categoria STRUCTURE e actorId', async () => {
    const created = await makeShift('Madrugada');

    expect(await eventsOf({ entityId: created.id })).toEqual([
      {
        action: 'shift.create',
        category: 'STRUCTURE',
        actorId: ACTOR,
        entityId: created.id,
        changes: [
          { field: 'name', before: null, after: 'Madrugada' },
          { field: 'startTime', before: null, after: '08:00' },
          { field: 'endTime', before: null, after: '12:00' },
          { field: 'isActive', before: null, after: true },
        ],
      },
    ]);
  });
});

describe('Turnos — trilha da alteração (aceite 16; Postgres exclusivo)', () => {
  it('aceite 16: renomear e trocar horário grava antes e depois só desses campos', async () => {
    const shift = await makeShift('Tarde');
    await shifts.update(OTHER_ACTOR, shift.id, {
      name: 'Tarde longa',
      endTime: '20:00',
    });

    const [, update] = await eventsOf({ entityId: shift.id });

    expect(update).toMatchObject({
      action: 'shift.update',
      category: 'STRUCTURE',
      actorId: OTHER_ACTOR,
      changes: [
        { field: 'name', before: 'Tarde', after: 'Tarde longa' },
        { field: 'endTime', before: '12:00', after: '20:00' },
      ],
    });
  });

  it('aceite 16: desativar turno sem uso grava isActive true → false', async () => {
    const shift = await makeShift('Extra');
    await shifts.update(ACTOR, shift.id, { isActive: false });

    const [, update] = await eventsOf({ entityId: shift.id });

    expect(update.changes).toEqual([
      { field: 'isActive', before: true, after: false },
    ]);
  });

  it('aceite 16: PATCH sem mudança — nenhum evento', async () => {
    const shift = await makeShift('Fixo');
    await shifts.update(ACTOR, shift.id, { name: 'Fixo', startTime: '08:00' });

    expect(await eventsOf({ entityId: shift.id })).toHaveLength(1);
  });
});

describe('Turnos — trilha da ordem (aceite 16; Postgres exclusivo)', () => {
  it('aceite 16: reordenar grava order antes e depois; mesma ordem — nenhum evento', async () => {
    await makeShift('Ordem A');
    await makeShift('Ordem B');
    const { ids, names } = await currentOrder();
    const reversed = [...ids].reverse();
    const already = (await eventsOf({ action: 'shift.reorder' })).length;

    await shifts.reorder(ACTOR, { ids: reversed });
    await shifts.reorder(ACTOR, { ids: reversed });

    const created = (await eventsOf({ action: 'shift.reorder' })).slice(
      already,
    );
    expect(created).toEqual([
      {
        action: 'shift.reorder',
        category: 'STRUCTURE',
        actorId: ACTOR,
        entityId: null,
        changes: [
          {
            field: 'order',
            before: names.join(' > '),
            after: [...names].reverse().join(' > '),
          },
        ],
      },
    ]);
  });
});

describe('Turnos — falha da trilha desfaz a gravação (Postgres exclusivo)', () => {
  it('falha na trilha desfaz a gravação do turno', async () => {
    const kept = await makeShift('Mantido');
    const before = await currentOrder();
    const failure = new Error('audit offline');
    const failing = vi.spyOn(audit, 'recordChange').mockRejectedValue(failure);

    try {
      await expect(makeShift('Perdido')).rejects.toBe(failure);
      await expect(
        shifts.update(ACTOR, kept.id, { name: 'Renomeado' }),
      ).rejects.toBe(failure);
      await expect(
        shifts.reorder(ACTOR, { ids: [...before.ids].reverse() }),
      ).rejects.toBe(failure);
    } finally {
      failing.mockRestore();
    }

    expect(await prisma.shift.findFirst({ where: { name: 'Perdido' } })).toBe(
      null,
    );
    expect(await currentOrder()).toEqual(before);
  });
});

describe('Turnos — consulta da trilha e turno em uso (aceite 16)', () => {
  it('aceite 16: eventos aparecem na consulta da trilha com categoria Estrutura', async () => {
    const admin = await makeAdmin();
    const shift = await makeShift('Visível', admin.id);
    await shifts.update(admin.id, shift.id, { isActive: false });

    const page = await trail.list(admin.id, {
      category: 'STRUCTURE',
      page: 1,
      pageSize: 100,
    });

    const mine = page.items.filter((entry) => entry.actor?.id === admin.id);
    expect(mine.map((e) => [e.action, e.category])).toEqual([
      ['shift.update', 'STRUCTURE'],
      ['shift.create', 'STRUCTURE'],
    ]);
    expect(mine[0].changes).toEqual([
      { field: 'isActive', before: true, after: false },
    ]);
  });

  it('turno em uso continua 409 shifts.in_use, sem evento', async () => {
    const shift = await makeShift('Em uso');
    await prisma.user.create({
      data: {
        name: 'Pessoa A',
        email: 'pessoa-a@test.local',
        password: randomUUID(),
        shiftId: shift.id,
      },
    });

    await expect(
      shifts.update(ACTOR, shift.id, { isActive: false }),
    ).rejects.toMatchObject({ status: 409, code: 'shifts.in_use' });

    expect(await eventsOf({ entityId: shift.id })).toHaveLength(1);
    expect((await currentOrder()).names).toContain('Em uso');
    expect(
      (await prisma.shift.findUniqueOrThrow({ where: { id: shift.id } }))
        .isActive,
    ).toBe(true);
  });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// Segura a linha do turno numa transação à parte (outra conexão) até `release`.
function holdRowLock(id: string) {
  const held = deferred();
  const release = deferred();
  const done = prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Shift" WHERE id = ${id} FOR NO KEY UPDATE`;
      held.resolve();
      await release.promise;
    },
    { timeout: 30_000 },
  );
  return { held: held.promise, release: release.resolve, done };
}

// Espera, com teto, `count` sessões bloqueadas numa trava no banco.
async function waitForBlocked(count: number) {
  await vi.waitFor(
    async () => {
      const [{ waiting }] = await prisma.$queryRaw<{ waiting: bigint }[]>`
        SELECT count(*) AS waiting FROM pg_stat_activity WHERE wait_event_type = 'Lock'`;
      expect(Number(waiting)).toBeGreaterThanOrEqual(count);
    },
    { timeout: 5000, interval: 20 },
  );
}

describe('Turnos — edições concorrentes do mesmo turno (aceite 16; Molde B)', () => {
  it('duas edições do mesmo turno intercaladas — o antes da segunda é o depois da primeira', async () => {
    // Sem a trava antes de ler o "antes", a segunda edição leria "Turno X":
    // as duas esperariam na gravação, mas ambas teriam lido o mesmo valor.
    const shift = await makeShift('Turno X');
    const lock = holdRowLock(shift.id);
    await lock.held;
    const edits: Promise<unknown>[] = [];
    try {
      edits.push(shifts.update(ACTOR, shift.id, { name: 'Turno Y' }));
      await waitForBlocked(1);
      edits.push(shifts.update(OTHER_ACTOR, shift.id, { name: 'Turno W' }));
      await waitForBlocked(2);
    } finally {
      lock.release();
    }
    await Promise.all([...edits, lock.done]);

    const updates = await eventsOf({
      entityId: shift.id,
      action: 'shift.update',
    });
    expect(updates.map((e) => [e.actorId, e.changes])).toEqual([
      [ACTOR, [{ field: 'name', before: 'Turno X', after: 'Turno Y' }]],
      [OTHER_ACTOR, [{ field: 'name', before: 'Turno Y', after: 'Turno W' }]],
    ]);
  });
});
