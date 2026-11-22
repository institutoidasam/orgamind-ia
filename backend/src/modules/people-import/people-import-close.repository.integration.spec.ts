import { randomUUID } from 'node:crypto';
import {
  type PeopleImportOutcome,
  type PeopleImportRowClass,
  type PeopleImportWriteState,
  type Prisma,
  PrismaClient,
} from '@prisma/client';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { deployMigrations } from '../../../test/migrations';
import type { PrismaService } from '../../shared/prisma/prisma.service';
import { PeopleImportCloseRepository } from './people-import-close.repository';
import type { ImportResultCounts } from './import-person';
import { ROW_TEXT } from './row-texts';

let postgres: StartedPostgreSqlContainer;
let prisma: PrismaClient;
let repo: PeopleImportCloseRepository;

const NOW = new Date('2026-11-19T15:00:00.000Z');
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const LIVE = new Date(NOW.getTime() + MINUTE);
const EXPIRED = new Date(NOW.getTime() - MINUTE);
const PLAN = { kind: 'create', keys: {}, input: { name: 'x', phone: '+5592' } };

type SeedRow = {
  n: number;
  classification?: PeopleImportRowClass;
  writeState?: PeopleImportWriteState | null;
  outcome?: PeopleImportOutcome;
  outcomeReason?: string;
  reservedUntil?: Date;
  personId?: string;
};

const cellsOf = (n: number) => ({
  '0': `Pessoa ${n}`,
  '1': `+55929911${1000 + n}`,
});

function rowData(row: SeedRow): Prisma.PeopleImportRowCreateWithoutBatchInput {
  const writeState = row.writeState === undefined ? 'PENDING' : row.writeState;
  const open = writeState === 'PENDING' || writeState === 'RESERVED';
  return {
    rowNumber: row.n,
    classification: row.classification ?? 'CREATE',
    writeState,
    outcome: row.outcome,
    outcomeReason: row.outcomeReason,
    reservedUntil: row.reservedUntil,
    reservationToken: row.reservedUntil ? `token-${row.n}` : undefined,
    personId: row.personId,
    cells: cellsOf(row.n),
    plan: open ? PLAN : undefined,
  };
}

const done = (
  n: number,
  outcome: PeopleImportOutcome,
  outcomeReason?: string,
): SeedRow => ({ n, writeState: 'DONE', outcome, outcomeReason });

const reserved = (
  n: number,
  reservedUntil: Date,
  personId?: string,
): SeedRow => ({
  n,
  writeState: 'RESERVED',
  reservedUntil,
  personId,
});

type BatchOver = Partial<Prisma.PeopleImportBatchCreateInput>;

async function seedBatch(
  id: string,
  rows: SeedRow[],
  over: BatchOver = {},
): Promise<void> {
  await prisma.peopleImportBatch.create({
    data: {
      id,
      fileName: 'pessoas.csv',
      fileSize: 120,
      fileSha256: 'a'.repeat(64),
      format: 'csv',
      headers: ['Nome', 'Telefone'],
      mapping: {},
      createdById: 'u-admin',
      status: 'WRITING',
      confirmedById: 'u-admin',
      confirmedAt: new Date(NOW.getTime() - 60 * MINUTE),
      lastBlockAt: new Date(NOW.getTime() - MINUTE),
      ...over,
      rows: { create: rows.map(rowData) },
    },
  });
}

async function seedPeople(ids: string[]): Promise<void> {
  await prisma.user.createMany({
    data: ids.map((id) => ({
      id,
      name: `Pessoa ${id}`,
      hasAccess: false,
      role: 'VIEWER' as const,
    })),
  });
}

const batchOf = (id: string) =>
  prisma.peopleImportBatch.findUniqueOrThrow({ where: { id } });

const rowAt = (batchId: string, rowNumber: number) =>
  prisma.peopleImportRow.findUniqueOrThrow({
    where: { batchId_rowNumber: { batchId, rowNumber } },
  });

/** [linha, resultado, motivo, pessoa, sem colunas, sem plano] de cada linha. */
async function snapshot(batchId: string) {
  const rows = await prisma.peopleImportRow.findMany({
    where: { batchId },
    orderBy: { rowNumber: 'asc' },
  });
  return rows.map((r) => [
    r.rowNumber,
    r.outcome,
    r.outcomeReason,
    r.personId,
    r.cells === null,
    r.plan === null,
  ]);
}

const trailMock = () => vi.fn().mockResolvedValue(undefined);

beforeAll(async () => {
  postgres = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('database_test')
    .withUsername(`user_${randomUUID().replaceAll('-', '')}`)
    .withPassword(randomUUID())
    .start();
  const databaseUrl = postgres.getConnectionUri();
  deployMigrations({ databaseUrl });
  prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  repo = new PeopleImportCloseRepository(prisma as unknown as PrismaService);
}, 240_000);

afterAll(async () => {
  await prisma?.$disconnect();
  await postgres?.stop();
});

const NOT_WRITTEN = ROW_TEXT.notWrittenClosed;

type TrailMock = ReturnType<typeof trailMock>;

const closeBatch = (batchId: string, trail: TrailMock = trailMock()) =>
  repo.close({ batchId, closedById: 'u-closer', now: NOW, trail });

describe('PeopleImportCloseRepository.completeIfDone: uma vez só', () => {
  it('completeIfDone grava a trilha uma vez mesmo com dois blocos terminando juntos', async () => {
    const batchId = 'b-done-twice';
    await seedBatch(batchId, [
      done(2, 'CREATED'),
      done(3, 'UPDATED'),
      { n: 4, classification: 'INVALID', writeState: null },
    ]);
    const trail = trailMock();
    const input = { batchId, now: NOW, trail };

    const results = await Promise.all([
      repo.completeIfDone(input),
      repo.completeIfDone(input),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(trail).toHaveBeenCalledTimes(1);
    const batch = await batchOf(batchId);
    expect(batch).toMatchObject({
      status: 'COMPLETED',
      finishedAt: NOW,
      result: { rows: 3, created: 1, updated: 1, invalid: 1, writing: 0 },
    });
    expect(trail).toHaveBeenCalledWith(expect.anything(), batch.result);
  });
});

describe('PeopleImportCloseRepository.completeIfDone: linha em aberto', () => {
  it('completeIfDone não conclui com linha pendente ou reservada', async () => {
    const cases: [string, SeedRow][] = [
      ['b-open-pending', { n: 3 }],
      ['b-open-live', reserved(3, LIVE)],
      ['b-open-expired', reserved(3, EXPIRED)],
    ];
    const trail = trailMock();

    for (const [batchId, open] of cases) {
      await seedBatch(batchId, [done(2, 'CREATED'), open]);
      const completed = await repo.completeIfDone({ batchId, now: NOW, trail });

      expect(completed).toBe(false);
      expect(await batchOf(batchId)).toMatchObject({
        status: 'WRITING',
        finishedAt: null,
        result: null,
      });
    }
    expect(trail).not.toHaveBeenCalled();
  });
});

describe('PeopleImportCloseRepository.close: encerramento', () => {
  it('close: pendentes e reservas vencidas viram Não gravada só com as colunas mapeadas; reserva viva fica', async () => {
    const batchId = 'b-close';
    await seedBatch(batchId, [
      { n: 2, classification: 'UPDATE' },
      reserved(3, EXPIRED, 'c-sem-pessoa'),
      reserved(4, LIVE, 'c-sem-pessoa-viva'),
      done(5, 'CREATED'),
      { n: 6, classification: 'INVALID', writeState: null },
    ]);
    const trail = trailMock();

    const counts = await closeBatch(batchId, trail);

    expect(counts).toMatchObject({
      rows: 5,
      created: 1,
      invalid: 1,
      notWritten: 2,
      writing: 1,
    });
    expect(await snapshot(batchId)).toEqual([
      [2, 'NOT_WRITTEN', NOT_WRITTEN, null, false, true],
      [3, 'NOT_WRITTEN', NOT_WRITTEN, 'c-sem-pessoa', false, true],
      [4, null, null, 'c-sem-pessoa-viva', false, false],
      [5, 'CREATED', null, null, false, true],
      [6, null, null, null, false, true],
    ]);
    expect(await rowAt(batchId, 2)).toMatchObject({ cells: cellsOf(2) });
    expect(await rowAt(batchId, 4)).toMatchObject({
      writeState: 'RESERVED',
      reservationToken: 'token-4',
    });
    expect(await batchOf(batchId)).toMatchObject({
      status: 'CLOSED',
      closedById: 'u-closer',
      finishedAt: NOW,
      result: counts,
    });
    expect(trail).toHaveBeenCalledWith(expect.anything(), counts);
  });
});

describe('PeopleImportCloseRepository.close: lote fora de WRITING', () => {
  it('close de lote fora de WRITING devolve null', async () => {
    const trail = trailMock();
    for (const status of ['PREVIEW', 'COMPLETED', 'CLOSED'] as const) {
      const batchId = `b-close-${status}`;
      await seedBatch(batchId, [{ n: 2 }], { status });

      const counts = await closeBatch(batchId, trail);

      expect(counts).toBeNull();
      expect(await rowAt(batchId, 2)).toMatchObject({ writeState: 'PENDING' });
      expect(await batchOf(batchId)).toMatchObject({
        status,
        closedById: null,
      });
    }
    expect(trail).not.toHaveBeenCalled();
  });
});

describe('PeopleImportCloseRepository: trilha que falha', () => {
  it('close e completeIfDone: se a trilha falha, o lote e as linhas ficam como estavam', async () => {
    await seedBatch('b-trail-close', [{ n: 2 }]);
    await seedBatch('b-trail-done', [done(2, 'CREATED')]);
    const trail = vi.fn().mockRejectedValue(new Error('trilha fora do ar'));
    const complete = { batchId: 'b-trail-done', now: NOW, trail };

    await Promise.all([
      expect(closeBatch('b-trail-close', trail)).rejects.toThrow(
        'trilha fora do ar',
      ),
      expect(repo.completeIfDone(complete)).rejects.toThrow(
        'trilha fora do ar',
      ),
    ]);

    expect(await batchOf('b-trail-close')).toMatchObject({
      status: 'WRITING',
      closedById: null,
      result: null,
    });
    expect(await rowAt('b-trail-close', 2)).toMatchObject({
      writeState: 'PENDING',
      outcome: null,
    });
    expect(await batchOf('b-trail-done')).toMatchObject({ status: 'WRITING' });
  });
});

describe('PeopleImportCloseRepository: encerrar e concluir juntos', () => {
  async function race(batchId: string) {
    await seedBatch(batchId, [done(2, 'CREATED'), done(3, 'UPDATED')]);
    const trail = trailMock();
    const [closed, completed] = await Promise.all([
      closeBatch(batchId, trail),
      repo.completeIfDone({ batchId, now: NOW, trail }),
    ]);
    return { closed, completed, trail, batch: await batchOf(batchId) };
  }

  it('close e completeIfDone ao mesmo tempo: só um encerra o lote e só uma trilha', async () => {
    const ids = ['b-race-1', 'b-race-2', 'b-race-3'];

    const rounds = await Promise.all(ids.map(race));

    for (const { closed, completed, trail, batch } of rounds) {
      expect(closed === null).toBe(completed);
      expect(trail).toHaveBeenCalledTimes(1);
      expect(batch.status).toBe(completed ? 'COMPLETED' : 'CLOSED');
      expect(batch.closedById).toBe(completed ? null : 'u-closer');
    }
  });
});

describe('PeopleImportCloseRepository.settleExpired', () => {
  it('settleExpired converte a reserva vencida de lote encerrado', async () => {
    const rows = [reserved(2, EXPIRED), reserved(3, LIVE), done(4, 'CREATED')];
    await seedBatch('b-settle', rows, { status: 'CLOSED', closedById: 'u-c' });
    await seedBatch('b-settle-writing', [reserved(2, EXPIRED)]);

    const settled = await repo.settleExpired('b-settle', NOW);
    const writing = await repo.settleExpired('b-settle-writing', NOW);

    expect(settled).toBe(1);
    expect(writing).toBe(0);
    expect(await snapshot('b-settle')).toEqual([
      [2, 'NOT_WRITTEN', NOT_WRITTEN, null, false, true],
      [3, null, null, null, false, false],
      [4, 'CREATED', null, null, false, true],
    ]);
    expect(await rowAt('b-settle-writing', 2)).toMatchObject({
      writeState: 'RESERVED',
    });
    expect(await repo.settleExpired('b-settle', NOW)).toBe(0);
    expect((await batchOf('b-settle')).result).toMatchObject({
      notWritten: 1,
      writing: 1,
    });
  });
});

describe('PeopleImportCloseRepository.close: criação já gravada (m8)', () => {
  it('close: linha de criação com personId de pessoa já existente vira CREATED, não NOT_WRITTEN', async () => {
    await seedPeople(['c-made-2', 'c-made-3', 'c-made-6']);
    await seedBatch('b-m8-close', [
      { n: 2, personId: 'c-made-2' },
      reserved(3, EXPIRED, 'c-made-3'),
      reserved(4, EXPIRED, 'c-ghost'),
      { n: 5 },
      { n: 6, classification: 'UPDATE', personId: 'c-made-6' },
    ]);

    const counts = await closeBatch('b-m8-close');

    expect(await snapshot('b-m8-close')).toEqual([
      [2, 'CREATED', null, 'c-made-2', true, true],
      [3, 'CREATED', null, 'c-made-3', true, true],
      [4, 'NOT_WRITTEN', NOT_WRITTEN, 'c-ghost', false, true],
      [5, 'NOT_WRITTEN', NOT_WRITTEN, null, false, true],
      [6, 'NOT_WRITTEN', NOT_WRITTEN, 'c-made-6', false, true],
    ]);
    expect(counts).toMatchObject({ rows: 5, created: 2, notWritten: 3 });
    expect((await batchOf('b-m8-close')).result).toEqual(counts);
  });
});

describe('PeopleImportCloseRepository.settleExpired: criação já gravada (m8)', () => {
  it('settleExpired: linha de criação com personId de pessoa já existente vira CREATED, não NOT_WRITTEN', async () => {
    await seedPeople(['c-late-2', 'c-late-4']);
    await seedBatch(
      'b-m8-settle',
      [
        reserved(2, EXPIRED, 'c-late-2'),
        reserved(3, EXPIRED, 'c-ghost'),
        { ...reserved(4, EXPIRED, 'c-late-4'), classification: 'UPDATE' },
        reserved(5, LIVE, 'c-late-2'),
      ],
      { status: 'CLOSED', closedById: 'u-c', result: { rows: 4, writing: 4 } },
    );

    const settled = await repo.settleExpired('b-m8-settle', NOW);

    expect(settled).toBe(3);
    expect(await snapshot('b-m8-settle')).toEqual([
      [2, 'CREATED', null, 'c-late-2', true, true],
      [3, 'NOT_WRITTEN', NOT_WRITTEN, 'c-ghost', false, true],
      [4, 'NOT_WRITTEN', NOT_WRITTEN, 'c-late-4', false, true],
      [5, null, null, 'c-late-2', false, false],
    ]);
    const counts = await repo.resultCounts('b-m8-settle', NOW);
    expect(counts).toMatchObject({ created: 1, notWritten: 2, writing: 1 });
    expect((await batchOf('b-m8-settle')).result).toEqual(counts);
  });
});

describe('PeopleImportCloseRepository.staleWriting', () => {
  it('staleWriting acha lotes parados há mais de 7 dias', async () => {
    const old = new Date(NOW.getTime() - 8 * DAY);
    const recent = new Date(NOW.getTime() - 6 * DAY);
    const over = (id: string, data: BatchOver) =>
      seedBatch(id, [{ n: 2 }], { confirmedById: `u-${id}`, ...data });
    await over('b-stale-block', { lastBlockAt: old, confirmedAt: recent });
    await over('b-stale-confirmed', { lastBlockAt: null, confirmedAt: old });
    await over('b-fresh-block', { lastBlockAt: recent, confirmedAt: old });
    await over('b-fresh-confirmed', { lastBlockAt: null, confirmedAt: recent });
    await over('b-old-completed', {
      status: 'COMPLETED',
      lastBlockAt: old,
      confirmedAt: old,
    });

    const stale = await repo.staleWriting(new Date(NOW.getTime() - 7 * DAY));

    const found = (id: string) => ({
      id,
      confirmedById: `u-${id}`,
      fileName: 'pessoas.csv',
    });
    expect(stale).toEqual([found('b-stale-confirmed'), found('b-stale-block')]);
  });
});

describe('PeopleImportCloseRepository.resultCounts: classificações e resultados', () => {
  it('resultCounts conta classificações e resultados, writing só com reserva viva', async () => {
    const plain = (n: number, classification: PeopleImportRowClass) => ({
      n,
      classification,
      writeState: null,
    });
    await seedBatch('b-counts', [
      done(2, 'CREATED'),
      done(3, 'CREATED'),
      { ...done(4, 'UPDATED'), classification: 'UPDATE' },
      { ...done(5, 'UNCHANGED'), classification: 'UPDATE' },
      plain(6, 'UNCHANGED'),
      plain(7, 'INVALID'),
      plain(8, 'DUPLICATE'),
      plain(9, 'CONFLICT'),
      plain(10, 'IGNORED'),
      done(11, 'FAILED', 'Falha qualquer'),
      { ...done(12, 'NOT_WRITTEN'), classification: 'UPDATE' },
      reserved(13, LIVE),
      reserved(14, EXPIRED),
      { n: 15 },
    ]);

    const counts = await repo.resultCounts('b-counts', NOW);

    expect(counts).toEqual({
      rows: 14,
      created: 2,
      updated: 1,
      unchanged: 2,
      invalid: 1,
      duplicate: 1,
      conflict: 1,
      ignored: 1,
      failed: 1,
      phoneTaken: 0,
      notWritten: 1,
      writing: 1,
    });
  });
});

describe('PeopleImportCloseRepository.resultCounts: telefone já cadastrado', () => {
  it('resultCounts conta phoneTaken pelas falhas com o texto de telefone já cadastrado', async () => {
    const failures = [
      done(3, 'FAILED', ROW_TEXT.phoneTaken),
      done(4, 'FAILED', ROW_TEXT.phoneTaken),
      done(5, 'FAILED', ROW_TEXT.changedAfterPreview),
    ];
    await seedBatch('b-phone-done', [done(2, 'CREATED'), ...failures]);
    await seedBatch('b-phone-close', [{ n: 2 }, ...failures]);
    const trail = trailMock();

    await repo.completeIfDone({ batchId: 'b-phone-done', now: NOW, trail });
    const closed = await closeBatch('b-phone-close', trail);

    const completed = await batchOf('b-phone-done');
    expect(completed.result).toMatchObject({ failed: 3, phoneTaken: 2 });
    expect(await repo.resultCounts('b-phone-done', NOW)).toEqual(
      completed.result,
    );
    expect(closed).toMatchObject({ failed: 3, phoneTaken: 2, notWritten: 1 });
    expect((await batchOf('b-phone-close')).result).toEqual(closed);
  });
});

/** Linhas contadas (sem `rows`, e sem `phoneTaken`, que é parte de `failed`). */
const counted = (c: ImportResultCounts) =>
  c.created +
  c.updated +
  c.unchanged +
  c.invalid +
  c.duplicate +
  c.conflict +
  c.ignored +
  c.failed +
  c.notWritten +
  c.writing;

type TxFn = (tx: Prisma.TransactionClient) => Promise<unknown>;
type TxOptions = { timeout?: number; isolationLevel?: 'RepeatableRead' };

/**
 * Cliente cujo `groupBy` de linhas, dentro de `$transaction`, roda `between`
 * uma vez logo depois de ler: o dono finaliza a linha no meio da contagem,
 * sem depender de tempo.
 */
function interleaved(between: () => Promise<unknown>): PrismaService {
  let hook: (() => Promise<unknown>) | null = between;
  const rowsOf = (tx: Prisma.TransactionClient) =>
    new Proxy(tx.peopleImportRow, {
      get(target, key) {
        const value: unknown = Reflect.get(target, key);
        if (key !== 'groupBy' || typeof value !== 'function') return value;
        return async (...args: unknown[]) => {
          const groups: unknown = await Reflect.apply(value, target, args);
          const run = hook;
          hook = null;
          await run?.();
          return groups;
        };
      },
    });
  const txOf = (tx: Prisma.TransactionClient) =>
    new Proxy(tx, {
      get: (target, key): unknown =>
        key === 'peopleImportRow' ? rowsOf(target) : Reflect.get(target, key),
    });
  return new Proxy(prisma, {
    get(target, key): unknown {
      if (key !== '$transaction') return Reflect.get(target, key);
      return (fn: TxFn, options?: TxOptions) =>
        target.$transaction((tx) => fn(txOf(tx)), options);
    },
  }) as unknown as PrismaService;
}

/** O dono finaliza a reserva da linha (como `finalizeRow`), fora da transação. */
const finalizeLater =
  (
    batchId: string,
    rowNumber: number,
    outcome: Prisma.PeopleImportRowUpdateManyMutationInput,
  ) =>
  () =>
    prisma.peopleImportRow.updateMany({
      where: { batchId, rowNumber, writeState: 'RESERVED' },
      data: { writeState: 'DONE', ...outcome },
    });

describe('PeopleImportCloseRepository.close: reserva viva finalizada durante a contagem', () => {
  it('close conta a linha uma vez só e phoneTaken ⊂ failed; settleExpired refaz o result', async () => {
    const batchId = 'b-race-close';
    await seedBatch(batchId, [
      done(2, 'CREATED'),
      { n: 3 },
      reserved(4, LIVE),
      { n: 5, classification: 'INVALID', writeState: null },
    ]);
    const phoneTaken = {
      outcome: 'FAILED' as const,
      outcomeReason: ROW_TEXT.phoneTaken,
    };
    const racing = new PeopleImportCloseRepository(
      interleaved(finalizeLater(batchId, 4, phoneTaken)),
    );

    const closed = await racing.close({
      batchId,
      closedById: 'u-closer',
      now: NOW,
      trail: trailMock(),
    });

    const counts = closed as ImportResultCounts;
    expect(counted(counts)).toBe(counts.rows);
    expect(counts.phoneTaken).toBeLessThanOrEqual(counts.failed);
    expect(counts).toMatchObject({ rows: 4, writing: 1, failed: 0 });
    expect((await batchOf(batchId)).result).toEqual(counts);
    expect(await repo.settleExpired(batchId, NOW)).toBe(0);
    const result = (await batchOf(batchId)).result as ImportResultCounts;
    expect(result).toMatchObject({ writing: 0, failed: 1, phoneTaken: 1 });
    expect(counted(result)).toBe(result.rows);
  });
});

describe('PeopleImportCloseRepository.resultCounts: uma foto só', () => {
  it('resultCounts não conta como writing a reserva vencida finalizada durante a contagem', async () => {
    const batchId = 'b-race-counts';
    await seedBatch(batchId, [done(2, 'CREATED'), reserved(3, EXPIRED)]);
    const racing = new PeopleImportCloseRepository(
      interleaved(finalizeLater(batchId, 3, { outcome: 'CREATED' })),
    );

    const counts = await racing.resultCounts(batchId, NOW);

    expect(counts).toMatchObject({ rows: 2, created: 1, writing: 0 });
    expect(await repo.resultCounts(batchId, NOW)).toMatchObject({
      created: 2,
      writing: 0,
    });
  });
});
