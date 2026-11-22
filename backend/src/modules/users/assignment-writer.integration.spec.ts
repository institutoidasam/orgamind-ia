import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { deployMigrations } from '../../../test/migrations';
import { fromDbDate } from '../staff-schedule/civil-date';
import { writeAssignment } from './assignment-writer';
import {
  NO_ASSIGNMENT,
  type AssignmentPatch,
  type AssignmentValues,
} from './assignment-timeline';
import type { PersonAuditRow } from './person-audit';
import { UsersRepository, type PersonUpdateTrail } from './users.repository';

// Um container + `migrate deploy` para o arquivo inteiro; `today` sempre explícito.
const TODAY = '2026-11-19';
const EVE = '2026-11-18';

let postgres: StartedPostgreSqlContainer;
let prisma: PrismaClient;
let repo: UsersRepository;
// Códigos dos conflitos que fizeram o `runSerializable` repetir a transação.
const retried: string[] = [];
let sectorA: string;
let sectorB: string;
let sectorC: string;

// Registra o código de cada transação que falhou, sem mudar o comportamento.
function recordingFailures(client: PrismaClient): PrismaClient {
  return new Proxy(client, {
    get(target, prop) {
      if (prop !== '$transaction') return Reflect.get(target, prop) as unknown;
      return (...args: Parameters<PrismaClient['$transaction']>) =>
        (target.$transaction as (...a: unknown[]) => Promise<unknown>)(
          ...args,
        ).catch((error: { code?: string }) => {
          retried.push(error.code ?? 'sem código');
          throw error;
        });
    },
  });
}

beforeAll(async () => {
  postgres = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('orgamind_test')
    .withUsername('orgamind')
    .withPassword('orgamind')
    .start();
  const url = postgres.getConnectionUri();
  deployMigrations({ databaseUrl: url });
  prisma = new PrismaClient({ datasources: { db: { url } } });
  repo = new UsersRepository(recordingFailures(prisma) as never);
  const sector = (code: string) =>
    prisma.sector
      .create({ data: { name: `Setor ${code}`, code } })
      .then((row) => row.id);
  [sectorA, sectorB, sectorC] = await Promise.all(
    ['VA', 'VB', 'VC'].map(sector),
  );
}, 180_000);

afterAll(async () => {
  await prisma?.$disconnect();
  await postgres?.stop();
});

let seq = 0;
// Pessoa sem acesso como o UsersService grava (D1).
const personData = () => ({
  name: `Pessoa ${(seq += 1)}`,
  hasAccess: false,
  role: 'VIEWER' as const,
  mustChangePassword: false,
});

/**
 * Pessoa gravada direto pelo Prisma, como a versão antiga do app. `migrated`
 * cria também a linha que a migração criou (início e fim em branco).
 */
async function legacyPerson(
  values: Partial<AssignmentValues>,
  migrated: boolean,
): Promise<string> {
  const user = await prisma.user.create({
    data: { ...personData(), ...values },
  });
  if (migrated)
    await prisma.userAssignment.create({
      data: { userId: user.id, ...values },
    });
  return user.id;
}

const line = (
  from: string | null,
  to: string | null,
  values: Partial<AssignmentValues>,
  recordedById: string | null,
) => ({ from, to, ...NO_ASSIGNMENT, ...values, recordedById });

async function linesOf(userId: string) {
  const rows = await prisma.userAssignment.findMany({
    where: { userId },
    orderBy: { validFrom: { sort: 'asc', nulls: 'first' } },
  });
  return rows.map((row) => ({
    from: row.validFrom ? fromDbDate(row.validFrom) : null,
    to: row.validTo ? fromDbDate(row.validTo) : null,
    sectorId: row.sectorId,
    shiftId: row.shiftId,
    levelId: row.levelId,
    recordedById: row.recordedById,
  }));
}

const mirrorOf = (userId: string) =>
  prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { sectorId: true, shiftId: true, levelId: true, updatedAt: true },
  });

const write = (userId: string, patch: AssignmentPatch, actorId = 'actor-1') =>
  prisma.$transaction((tx) =>
    writeAssignment(tx, {
      userId,
      patch,
      today: TODAY,
      actorId,
      origin: 'CHANGE',
    }),
  );

const change = (
  userId: string,
  patch: AssignmentPatch,
  actorId: string,
  audit?: PersonUpdateTrail,
) =>
  repo.updateWithLastAdminGuard(userId, {}, audit, {
    patch,
    today: TODAY,
    actorId,
  });

const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

describe('writeAssignment na criação (aceite 19)', () => {
  it('criação abre uma linha com início hoje e grava o espelho', async () => {
    const values = {
      sectorId: sectorA,
      shiftId: 'shift_first',
      levelId: 'level_employee',
    };
    const seen: PersonAuditRow[] = [];

    const created = await repo.createWithAudit(
      personData(),
      (_tx, row) => {
        seen.push(row);
        return Promise.resolve();
      },
      { patch: values, today: TODAY, actorId: 'admin-1' },
    );

    expect(await linesOf(created.id)).toEqual([
      line(TODAY, null, values, 'admin-1'),
    ]);
    expect(await mirrorOf(created.id)).toMatchObject(values);
    // Resumo e retrato da trilha lidos depois da função.
    expect(created).toMatchObject(values);
    expect(seen[0]).toMatchObject({
      sector: { id: sectorA },
      workShift: { id: 'shift_first' },
      level: { id: 'level_employee' },
    });
  }, 60_000);

  it('sem o parâmetro, a criação abre a linha com os três em branco', async () => {
    const created = await repo.createWithAudit(personData(), () =>
      Promise.resolve(),
    );

    const [only, ...rest] = await linesOf(created.id);
    expect(rest).toEqual([]);
    expect(only).toMatchObject({
      ...NO_ASSIGNMENT,
      to: null,
      recordedById: null,
    });
    expect(only.from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  }, 60_000);
});

describe('writeAssignment na troca (aceite 19)', () => {
  it('troca em outro dia fecha a aberta na véspera e abre hoje; espelho igual à aberta', async () => {
    const id = await legacyPerson({ sectorId: sectorA }, true);

    await expect(write(id, { sectorId: sectorB })).resolves.toEqual({
      kind: 'CLOSE_AND_OPEN',
      closeTo: EVE,
      values: { ...NO_ASSIGNMENT, sectorId: sectorB },
      from: TODAY,
    });

    expect(await linesOf(id)).toEqual([
      line(null, EVE, { sectorId: sectorA }, null),
      line(TODAY, null, { sectorId: sectorB }, 'actor-1'),
    ]);
    expect(await mirrorOf(id)).toMatchObject({
      ...NO_ASSIGNMENT,
      sectorId: sectorB,
    });
  }, 60_000);

  it('A→B→A no mesmo dia: fecha uma vez, atualiza a aberta, sem linha de duração zero', async () => {
    const id = await legacyPerson({ sectorId: sectorA }, true);

    await write(id, { sectorId: sectorB });
    await expect(write(id, { sectorId: sectorA }, 'actor-2')).resolves.toEqual({
      kind: 'UPDATE_OPEN',
      values: { ...NO_ASSIGNMENT, sectorId: sectorA },
    });

    expect(await linesOf(id)).toEqual([
      line(null, EVE, { sectorId: sectorA }, null),
      line(TODAY, null, { sectorId: sectorA }, 'actor-2'),
    ]);
    expect(await mirrorOf(id)).toMatchObject({ sectorId: sectorA });
  }, 60_000);
});

describe('writeAssignment no mesmo dia da criação (aceite 19)', () => {
  it('criada hoje e trocada hoje: uma linha aberta, atualizada no lugar', async () => {
    const created = await repo.createWithAudit(
      personData(),
      () => Promise.resolve(),
      { patch: { sectorId: sectorA }, today: TODAY, actorId: 'admin-1' },
    );
    const first = await prisma.userAssignment.findFirstOrThrow({
      where: { userId: created.id },
    });

    const result = await change(created.id, { sectorId: sectorB }, 'admin-2');

    expect(result).toMatchObject({ updated: { sector: { id: sectorB } } });
    expect(await linesOf(created.id)).toEqual([
      line(TODAY, null, { sectorId: sectorB }, 'admin-2'),
    ]);
    const updated = await prisma.userAssignment.findUniqueOrThrow({
      where: { id: first.id },
    });
    expect(updated.recordedAt.getTime()).toBeGreaterThan(
      first.recordedAt.getTime(),
    );
    expect(await mirrorOf(created.id)).toMatchObject({ sectorId: sectorB });
  }, 60_000);
});

describe('writeAssignment sem mudança e sem linha (DV8)', () => {
  it('sem mudança não grava linha nem espelho', async () => {
    const withLine = await legacyPerson({ sectorId: sectorA }, true);
    const withoutLine = await legacyPerson({ sectorId: sectorA }, false);
    const [lineBefore, mirrorBefore] = await Promise.all([
      prisma.userAssignment.findFirstOrThrow({ where: { userId: withLine } }),
      mirrorOf(withoutLine),
    ]);

    await expect(write(withLine, {})).resolves.toEqual({ kind: 'NONE' });
    await expect(write(withoutLine, { sectorId: sectorA })).resolves.toEqual({
      kind: 'NONE',
    });

    await expect(
      prisma.userAssignment.findMany({ where: { userId: withLine } }),
    ).resolves.toEqual([lineBefore]);
    expect(await linesOf(withoutLine)).toEqual([]);
    expect(await mirrorOf(withoutLine)).toEqual(mirrorBefore);
  }, 60_000);

  it('pessoa sem linha (fixture antiga) materializa a linha migrada antes de fechar', async () => {
    const legacy = { sectorId: sectorA, shiftId: 'shift_first' };
    const id = await legacyPerson(legacy, false);

    await write(id, { levelId: 'level_employee' });

    expect(await linesOf(id)).toEqual([
      line(null, EVE, legacy, null),
      line(TODAY, null, { ...legacy, levelId: 'level_employee' }, 'actor-1'),
    ]);
    expect(await mirrorOf(id)).toMatchObject({
      ...legacy,
      levelId: 'level_employee',
    });
  }, 60_000);
});

describe('writeAssignment com a trilha na transação (GV2)', () => {
  it('se a trilha lançar, linha e espelho não ficam', async () => {
    const id = await legacyPerson({ sectorId: sectorA }, true);

    await expect(
      change(id, { sectorId: sectorB }, 'admin-1', () =>
        Promise.reject(new Error('trilha falhou')),
      ),
    ).rejects.toThrow('trilha falhou');

    expect(await linesOf(id)).toEqual([
      line(null, null, { sectorId: sectorA }, null),
    ]);
    expect(await mirrorOf(id)).toMatchObject({ sectorId: sectorA });
  }, 60_000);
});

// Uma linha aberta só, igual ao espelho, e a fechada anterior termina na véspera.
async function expectSingleOpenEqualMirror(
  id: string,
  closed: Partial<AssignmentValues>,
) {
  const [first, open, ...rest] = await linesOf(id);
  const { sectorId, shiftId, levelId } = await mirrorOf(id);
  expect(rest).toEqual([]);
  expect(first).toEqual(line(null, EVE, closed, null));
  expect(open).toMatchObject({
    from: TODAY,
    to: null,
    sectorId,
    shiftId,
    levelId,
  });
  return open;
}

describe('writeAssignment com trocas simultâneas (concorrência)', () => {
  it('duas trocas simultâneas da mesma pessoa terminam com uma linha aberta igual ao espelho, sem sobreposição', async () => {
    const id = await legacyPerson({ sectorId: sectorA }, true);

    const results = await Promise.all([
      change(id, { sectorId: sectorB }, 'admin-1'),
      change(id, { sectorId: sectorC }, 'admin-2'),
    ]);

    expect(results.map((result) => 'updated' in result)).toEqual([true, true]);
    const open = await expectSingleOpenEqualMirror(id, { sectorId: sectorA });
    expect([sectorB, sectorC]).toContain(open.sectorId);
  }, 60_000);

  it('duas trocas simultâneas só de turno em pessoa sem linha aberta: nenhuma termina com 500 por P2002', async () => {
    const id = await legacyPerson({}, false);
    retried.length = 0;
    // A trilha segura a primeira transação aberta: a segunda chega à inserção
    // da linha migrada enquanto a primeira ainda não confirmou.
    const slowTrail: PersonUpdateTrail = () => pause(300);

    const results = await Promise.all([
      change(id, { shiftId: 'shift_first' }, 'admin-1', slowTrail),
      change(id, { shiftId: 'shift_second' }, 'admin-2', slowTrail),
    ]);

    expect(results.map((result) => 'updated' in result)).toEqual([true, true]);
    const open = await expectSingleOpenEqualMirror(id, {});
    expect(['shift_first', 'shift_second']).toContain(open.shiftId);
    // A perdedora repetiu. No Postgres 16 ela, que já leu a linha aberta, recebe
    // 40001 (P2034); sem a leitura viria 23505 (P2002, target ['userId']).
    expect(retried.length).toBeGreaterThan(0);
    expect(retried.every((code) => ['P2034', 'P2002'].includes(code))).toBe(
      true,
    );
  }, 60_000);
});
