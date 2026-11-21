import { randomUUID } from 'node:crypto';
import { Reflector } from '@nestjs/core';
import { PrismaClient, type Prisma } from '@prisma/client';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { deployMigrations } from '../../../test/migrations';
import { levelAdminSchema } from '../../schemas/contracts/level.schema';
import { AuditRepository } from '../../shared/audit/audit.repository';
import { AuditService } from '../../shared/audit/audit.service';
import { PERMISSION_KEY } from '../auth/decorators/require-permission.decorator';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { AuditTrailRepository } from '../audit-trail/audit-trail.repository';
import { AuditTrailService } from '../audit-trail/audit-trail.service';
import { LevelsController } from './levels.controller';
import { LevelsRepository } from './levels.repository';
import { LevelsService } from './levels.service';

const ACTOR = 'admin-1';
const OTHER_ACTOR = 'admin-2';
const UPDATE_ROUTE = 'update';

let postgres: StartedPostgreSqlContainer;
let prisma: PrismaClient;
let levels: LevelsService;
let trail: AuditTrailService;
let seq = 0;

beforeAll(async () => {
  postgres = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('database_test')
    .withUsername(`user_${randomUUID().replaceAll('-', '')}`)
    .withPassword(randomUUID())
    .start();
  // Pool folgado: os testes de concorrência mantêm várias sessões abertas ao mesmo tempo.
  const databaseUrl = `${postgres.getConnectionUri()}?connection_limit=10`;
  deployMigrations({ databaseUrl });
  prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const audit = new AuditService(new AuditRepository(prisma as never), {
    get: () => undefined,
  } as never);
  levels = new LevelsService(new LevelsRepository(prisma as never), audit);
  trail = new AuditTrailService(new AuditTrailRepository(prisma as never));
}, 240_000);

afterAll(async () => {
  await prisma?.$disconnect();
  await postgres?.stop();
});

/** Nível gravado direto, sem trilha: o teste parte de zero evento. */
function makeLevel(isActive = true) {
  seq += 1;
  return prisma.staffLevel.create({
    data: { name: `Nível ${seq}`, sortOrder: 100 + seq, isActive },
  });
}

function makePerson(
  levelId: string | null,
  data: Partial<Prisma.UserUncheckedCreateInput> = {},
) {
  seq += 1;
  return prisma.user.create({
    data: {
      email: `pessoa${seq}@test.local`,
      password: randomUUID(),
      name: `Pessoa ${seq}`,
      role: 'OPERATOR',
      levelId,
      ...data,
    },
  });
}

const deactivate = (id: string) =>
  levels.update(ACTOR, id, { isActive: false });
const isActive = async (id: string) =>
  (await prisma.staffLevel.findUniqueOrThrow({ where: { id } })).isActive;
const levelEvents = (id: string) =>
  prisma.auditEvent.count({ where: { entity: 'StaffLevel', entityId: id } });

function eventsOf(where: Prisma.AuditEventWhereInput) {
  return prisma.auditEvent.findMany({
    where: { entity: 'StaffLevel', ...where },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: {
      action: true,
      category: true,
      actorId: true,
      entityId: true,
      changes: true,
    },
  });
}

async function currentOrder() {
  const { items } = await levels.list();
  return { ids: items.map((l) => l.id), names: items.map((l) => l.name) };
}

describe('Nível em uso — pessoas ativas (E3, aceite 14)', () => {
  it('aceite 14: nível com pessoa ativa — 409 levels.in_use people=1; nível continua ativo; nenhum evento', async () => {
    const level = await makeLevel();
    await makePerson(level.id, {
      name: 'Fulana Reservada',
      email: 'fulana.reservada@test.local',
    });

    const error = await deactivate(level.id).catch((e: unknown) => e);

    expect(error).toMatchObject({
      code: 'levels.in_use',
      status: 409,
      detail: 'people=1',
    });
    expect(JSON.stringify(error)).not.toMatch(/Fulana|reservada/i);
    expect(await isActive(level.id)).toBe(true);
    expect(await levelEvents(level.id)).toBe(0);
  });

  it('aceite 14: só pessoa inativa — desativa; a pessoa mantém levelId', async () => {
    const level = await makeLevel();
    const former = await makePerson(level.id, { isActive: false });

    await deactivate(level.id);

    expect(await isActive(level.id)).toBe(false);
    const kept = await prisma.user.findUniqueOrThrow({
      where: { id: former.id },
    });
    expect(kept.levelId).toBe(level.id);
  });
});

describe('Nível — contagens na lista (E4)', () => {
  it('lista traz activePeople e inactivePeople', async () => {
    const level = await makeLevel();
    await makePerson(level.id);
    await makePerson(level.id);
    await makePerson(level.id, { isActive: false });

    const { items } = await levels.list();

    const item = items.find((l) => l.id === level.id);
    expect(levelAdminSchema.parse(item)).toMatchObject({
      activePeople: 2,
      inactivePeople: 1,
      userCount: 3,
    });
    expect(items.every((l) => l.activePeople >= 0)).toBe(true);
  });
});

describe('Nível — trilha da gravação (E8, aceite 16)', () => {
  it('aceite 16: criar, renomear, desativar e reativar gravam level.* com antes e depois, categoria STRUCTURE', async () => {
    const created = await levels.create(ACTOR, { name: 'Nível T' });
    await levels.update(OTHER_ACTOR, created.id, { name: 'Nível T2' });
    await levels.update(ACTOR, created.id, { isActive: false });
    await levels.update(ACTOR, created.id, { isActive: true });

    const base = { category: 'STRUCTURE', entityId: created.id };
    expect(await eventsOf({ entityId: created.id })).toEqual([
      {
        ...base,
        action: 'level.create',
        actorId: ACTOR,
        changes: [
          { field: 'name', before: null, after: 'Nível T' },
          { field: 'isActive', before: null, after: true },
        ],
      },
      {
        ...base,
        action: 'level.update',
        actorId: OTHER_ACTOR,
        changes: [{ field: 'name', before: 'Nível T', after: 'Nível T2' }],
      },
      {
        ...base,
        action: 'level.update',
        actorId: ACTOR,
        changes: [{ field: 'isActive', before: true, after: false }],
      },
      {
        ...base,
        action: 'level.update',
        actorId: ACTOR,
        changes: [{ field: 'isActive', before: false, after: true }],
      },
    ]);
  });

  it('aceite 16: sem mudança — nenhum evento', async () => {
    const level = await makeLevel();

    await levels.update(ACTOR, level.id, { name: level.name, isActive: true });

    expect(await levelEvents(level.id)).toBe(0);
  });
});

describe('Nível — trilha da ordem (E8, aceite 16)', () => {
  it('aceite 16: reordenar grava order; mesma ordem — nada', async () => {
    const { ids, names } = await currentOrder();
    const reversed = [...ids].reverse();
    const already = (await eventsOf({ action: 'level.reorder' })).length;

    await levels.reorder(ACTOR, reversed);
    await levels.reorder(ACTOR, reversed);

    const created = (await eventsOf({ action: 'level.reorder' })).slice(
      already,
    );
    expect(created).toEqual([
      {
        action: 'level.reorder',
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

describe('Nível — consulta da trilha e permissão (aceite 16)', () => {
  it('aceite 16: eventos level.* aparecem na consulta da trilha com categoria Estrutura', async () => {
    const admin = await makePerson(null, { role: 'ADMIN' });
    const level = await levels.create(admin.id, { name: 'Nível Visível' });
    await levels.update(admin.id, level.id, { isActive: false });

    const page = await trail.list(admin.id, {
      category: 'STRUCTURE',
      page: 1,
      pageSize: 100,
    });

    const mine = page.items.filter((entry) => entry.actor?.id === admin.id);
    expect(mine.map((e) => [e.action, e.category])).toEqual([
      ['level.update', 'STRUCTURE'],
      ['level.create', 'STRUCTURE'],
    ]);
    expect(mine[0].changes).toEqual([
      { field: 'isActive', before: true, after: false },
    ]);
  });

  it('desativar e reativar não exigem nada além de estrutura.manter (permissão de hoje)', async () => {
    const reflector = new Reflector();
    const route = LevelsController.prototype[UPDATE_ROUTE];
    const level = await makeLevel();

    expect(reflector.get(PERMISSION_KEY, LevelsController)).toBe(
      'estrutura.manter',
    );
    expect(reflector.get(PERMISSION_KEY, route)).toBeUndefined();
    expect(reflector.get(ROLES_KEY, route)).toBeUndefined();
    await deactivate(level.id);
    await levels.update(ACTOR, level.id, { isActive: true });
    expect(await isActive(level.id)).toBe(true);
  });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// Segura a linha do nível numa transação à parte (outra conexão) até `release`.
function holdRowLock(id: string) {
  const held = deferred();
  const release = deferred();
  const done = prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM "StaffLevel" WHERE id = ${id} FOR NO KEY UPDATE`;
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

describe('Nível — a conferência decide a gravação (Molde A, aceite 14)', () => {
  it('aceite 14: desativação bloqueada na trava do nível, pessoa ativa com o nível criada e commitada por outra conexão, trava solta — 409 levels.in_use people=1; nível continua ativo', async () => {
    // Molde A do GJ11: este teste FALHA se a conferência de uso rodar fora da
    // transação travada (antes do `SELECT … FOR NO KEY UPDATE` do repositório):
    // ela veria zero pessoas, a gravação passaria e o 409 esperado não viria.
    const level = await makeLevel();
    let outcome: Promise<unknown> | undefined;

    await prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "StaffLevel" WHERE id = ${level.id} FOR NO KEY UPDATE`;
        outcome = deactivate(level.id).then(
          () => null,
          (error: unknown) => error,
        );
        await waitForBlocked(1);
        await makePerson(level.id);
      },
      { timeout: 15_000 },
    );

    expect(await outcome).toMatchObject({
      code: 'levels.in_use',
      status: 409,
      detail: 'people=1',
    });
    expect(await isActive(level.id)).toBe(true);
    expect(await levelEvents(level.id)).toBe(0);
  });
});

describe('Nível — edições concorrentes do mesmo nível (Molde B, aceite 16)', () => {
  it('duas edições do mesmo nível intercaladas — o antes da segunda é o depois da primeira', async () => {
    // Sem a trava antes de ler o "antes", a segunda edição leria "Nível X":
    // as duas esperariam na gravação, mas ambas teriam lido o mesmo valor.
    const level = await levels.create(ACTOR, { name: 'Nível X' });
    const lock = holdRowLock(level.id);
    await lock.held;
    const edits: Promise<unknown>[] = [];
    try {
      edits.push(levels.update(ACTOR, level.id, { name: 'Nível Y' }));
      await waitForBlocked(1);
      edits.push(levels.update(OTHER_ACTOR, level.id, { name: 'Nível W' }));
      await waitForBlocked(2);
    } finally {
      lock.release();
    }
    await Promise.all([...edits, lock.done]);

    const updates = await eventsOf({
      entityId: level.id,
      action: 'level.update',
    });
    expect(updates.map((e) => [e.actorId, e.changes])).toEqual([
      [ACTOR, [{ field: 'name', before: 'Nível X', after: 'Nível Y' }]],
      [OTHER_ACTOR, [{ field: 'name', before: 'Nível Y', after: 'Nível W' }]],
    ]);
  });
});
