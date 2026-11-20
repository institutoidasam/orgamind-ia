import { randomUUID } from 'node:crypto';
import {
  type PeopleImportStatus,
  type Prisma,
  PrismaClient,
} from '@prisma/client';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deployMigrations } from '../../../test/migrations';
import type { PrismaService } from '../../shared/prisma/prisma.service';
import type { RowOutcome } from './import-person';
import {
  PeopleImportWriteRepository,
  type ReservedRow,
} from './people-import-write.repository';

let postgres: StartedPostgreSqlContainer;
let prisma: PrismaClient;
let repo: PeopleImportWriteRepository;

const NOW = new Date('2026-11-19T15:00:00.000Z');
const FIVE_MIN_AND_1S = 5 * 60 * 1000 + 1000;
const CREATE_PLAN = {
  kind: 'create',
  keys: { registrationKey: null, phoneE164: '+5592991110001' },
  input: { name: 'Ana Souza', phone: '+5592991110001' },
};
const UPDATE_PLAN = {
  kind: 'update',
  keys: { registrationKey: 'mat-9', phoneE164: null },
  personId: 'pessoa-da-previa',
  fingerprint: 'f'.repeat(64),
  patch: { jobTitle: 'Analista' },
};

/** Lote com uma linha pendente por plano (rowNumber = posição + 2). */
async function seedBatch(
  id: string,
  plans: Prisma.InputJsonValue[],
  status: PeopleImportStatus = 'WRITING',
): Promise<string[]> {
  await prisma.peopleImportBatch.createMany({
    data: [
      {
        id,
        fileName: 'equipe.xlsx',
        fileSize: 900,
        fileSha256: 'b'.repeat(64),
        format: 'xlsx',
        headers: ['Nome', 'Telefone'],
        mapping: {},
        createdById: 'u-admin',
        status,
      },
    ],
  });
  const ids = plans.map((_, index) => `${id}-r${index + 2}`);
  await prisma.peopleImportRow.createMany({
    data: plans.map((plan, index) => ({
      id: ids[index],
      batchId: id,
      rowNumber: index + 2,
      cells: { '0': `Pessoa ${index + 2}`, '1': '+5592991110001' },
      classification: plan === UPDATE_PLAN ? 'UPDATE' : 'CREATE',
      plan,
      personId: plan === UPDATE_PLAN ? 'pessoa-da-previa' : null,
      writeState: 'PENDING',
    })),
  });
  return ids;
}

async function drain(batchId: string, token: string): Promise<ReservedRow[]> {
  const got: ReservedRow[] = [];
  for (;;) {
    const row = await repo.reserveNextRow({ batchId, now: NOW, token });
    if (!row) return got;
    got.push(row);
  }
}

const rowById = (id: string) =>
  prisma.peopleImportRow.findUniqueOrThrow({ where: { id } });

beforeAll(async () => {
  postgres = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('database_test')
    .withUsername(`user_${randomUUID().replaceAll('-', '')}`)
    .withPassword(randomUUID())
    .start();
  const databaseUrl = postgres.getConnectionUri();
  deployMigrations({ databaseUrl });
  prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  repo = new PeopleImportWriteRepository(prisma as unknown as PrismaService);
}, 240_000);

afterAll(async () => {
  await prisma?.$disconnect();
  await postgres?.stop();
});

const reserve = (batchId: string, token: string, now: Date = NOW) =>
  repo.reserveNextRow({ batchId, now, token });
const later = (ms: number) => new Date(NOW.getTime() + ms);
const CREATED = { outcome: 'CREATED', reason: null, personId: 'p-1' } as const;
const finalize = (rowId: string, token: string, result: RowOutcome = CREATED) =>
  repo.finalizeRow({ rowId, token, now: NOW, result });

const sleep = (ms: number) =>
  new Promise<'waited'>((resolve) => setTimeout(() => resolve('waited'), ms));

/** Faz `lock` numa transação interativa e a mantém aberta enquanto `during`
 * roda (outra conexão); só então confirma. */
async function holding<T>(
  lock: (tx: Prisma.TransactionClient) => Promise<unknown>,
  during: () => Promise<T>,
): Promise<T> {
  let result!: T;
  await prisma.$transaction(async (tx) => {
    await lock(tx);
    result = await during();
  });
  return result;
}

describe('PeopleImportWriteRepository.reserveNextRow: concorrência', () => {
  it('reserveNextRow: dois pedidos simultâneos nunca pegam a mesma linha', async () => {
    const ids = await seedBatch(
      'b-race',
      Array.from({ length: 10 }, () => CREATE_PLAN),
    );

    const [first, second] = await Promise.all([
      drain('b-race', 'token-a'),
      drain('b-race', 'token-b'),
    ]);

    const taken = [...first, ...second].map((row) => row.id);
    expect(new Set(taken).size).toBe(10);
    expect(taken.slice().sort()).toEqual(ids.slice().sort());
    for (const row of first) {
      expect((await rowById(row.id)).reservationToken).toBe('token-a');
    }
  });
});

describe('PeopleImportWriteRepository.reserveNextRow: bloqueios', () => {
  it('SKIP LOCKED: com a 2ª linha travada por outra transação, a reserva pega a 3ª sem esperar', async () => {
    const [done, locked, free] = await seedBatch('b-skip', [
      CREATE_PLAN,
      CREATE_PLAN,
      CREATE_PLAN,
    ]);
    await prisma.peopleImportRow.update({
      where: { id: done },
      data: { writeState: 'DONE' },
    });

    const got = await holding(
      (tx) =>
        tx.$queryRaw`SELECT "id" FROM "PeopleImportRow" WHERE "id" = ${locked} FOR UPDATE`,
      () => Promise.race([reserve('b-skip', 'token-a'), sleep(3000)]),
    );

    expect(got).not.toBe('waited');
    expect((got as ReservedRow).id).toBe(free);
    expect((await rowById(locked)).writeState).toBe('PENDING');
  });

  it('FOR SHARE: com um close ainda não confirmado, a reserva espera e depois não reserva', async () => {
    const [rowId] = await seedBatch('b-closing', [CREATE_PLAN]);

    const { pending, early } = await holding(
      (tx) =>
        tx.peopleImportBatch.update({
          where: { id: 'b-closing' },
          data: { status: 'CLOSED' },
        }),
      async () => {
        const pending = reserve('b-closing', 'token-a');
        const early = await Promise.race([pending, sleep(500)]);
        return { pending, early };
      },
    );

    expect(early).toBe('waited');
    expect(await pending).toBeNull();
    expect((await rowById(rowId)).writeState).toBe('PENDING');
  });
});

describe('PeopleImportWriteRepository.reserveNextRow: vencimento', () => {
  it('reserva vencida volta a ser reservável; finalizeRow com token antigo não grava', async () => {
    const [rowId] = await seedBatch('b-expire', [CREATE_PLAN]);
    await reserve('b-expire', 'token-a');
    expect((await rowById(rowId)).reservedUntil).toEqual(later(5 * 60 * 1000));

    expect(await reserve('b-expire', 'token-b', later(60_000))).toBeNull();
    const again = await reserve('b-expire', 'token-b', later(FIVE_MIN_AND_1S));

    expect(again?.id).toBe(rowId);
    expect(await finalize(rowId, 'token-a')).toBe(false);
    expect(await rowById(rowId)).toMatchObject({
      writeState: 'RESERVED',
      reservationToken: 'token-b',
      outcome: null,
    });
    expect(await finalize(rowId, 'token-b')).toBe(true);
    expect(await rowById(rowId)).toMatchObject({
      writeState: 'DONE',
      outcome: 'CREATED',
    });
  });
});

describe('PeopleImportWriteRepository.reserveNextRow: personId', () => {
  it('reserveNextRow dá personId à linha de criação e mantém o mesmo depois que a reserva vence', async () => {
    await seedBatch('b-person', [CREATE_PLAN, UPDATE_PLAN]);

    const created = await reserve('b-person', 'token-a');
    const updated = await reserve('b-person', 'token-a');
    const retaken = await reserve(
      'b-person',
      'token-b',
      later(FIVE_MIN_AND_1S),
    );

    expect(created?.rowNumber).toBe(2);
    expect(created?.plan).toEqual(CREATE_PLAN);
    expect(created?.personId).toMatch(/^c[0-9a-f]{32}$/);
    expect(updated?.rowNumber).toBe(3);
    expect(updated?.personId).toBe('pessoa-da-previa');
    expect(retaken?.rowNumber).toBe(2);
    expect(retaken?.personId).toBe(created?.personId);
    expect((await rowById('b-person-r2')).personId).toBe(created?.personId);
  });
});

describe('PeopleImportWriteRepository: lote e andamento', () => {
  it('reserveNextRow não reserva em lote fora de WRITING', async () => {
    const [preview] = await seedBatch(
      'b-preview-only',
      [CREATE_PLAN],
      'PREVIEW',
    );
    const [closed] = await seedBatch('b-closed', [CREATE_PLAN], 'CLOSED');

    expect(await reserve('b-preview-only', 't')).toBeNull();
    expect(await reserve('b-closed', 't')).toBeNull();

    for (const id of [preview, closed]) {
      expect(await rowById(id)).toMatchObject({
        writeState: 'PENDING',
        reservationToken: null,
        personId: null,
      });
    }
  });

  it('touchBlock grava lastBlockAt', async () => {
    await seedBatch('b-touch', [CREATE_PLAN]);

    await repo.touchBlock('b-touch', NOW);

    const batch = await prisma.peopleImportBatch.findUniqueOrThrow({
      where: { id: 'b-touch' },
    });
    expect(batch.lastBlockAt).toEqual(NOW);
  });
});

describe('PeopleImportWriteRepository.finalizeRow: o que fica na linha', () => {
  it('finalizeRow: linha gravada perde cells e plan; falha guarda as colunas mapeadas', async () => {
    const [okId, failId] = await seedBatch('b-finalize', [
      CREATE_PLAN,
      CREATE_PLAN,
    ]);
    const ok = await reserve('b-finalize', 'ta');
    const failed = await reserve('b-finalize', 'tb');
    const failure: RowOutcome = {
      outcome: 'FAILED',
      reason: 'x'.repeat(250),
      personId: null,
    };

    expect(
      await finalize(okId, 'ta', {
        ...CREATED,
        personId: ok?.personId ?? null,
      }),
    ).toBe(true);
    expect(await finalize(failId, 'tb', failure)).toBe(true);

    expect(await rowById(okId)).toMatchObject({
      writeState: 'DONE',
      outcome: 'CREATED',
      personId: ok?.personId,
      writtenAt: NOW,
      cells: null,
      plan: null,
      outcomeReason: null,
    });
    const failedRow = await rowById(failId);
    expect(failedRow).toMatchObject({
      writeState: 'DONE',
      outcome: 'FAILED',
      plan: null,
      personId: failed?.personId,
      cells: { '0': 'Pessoa 3', '1': '+5592991110001' },
    });
    expect(failedRow.outcomeReason).toBe('x'.repeat(200));
  });
});

describe('PeopleImportWriteRepository.touchBlock: só em WRITING', () => {
  it('touchBlock não mexe em lote que não está em WRITING', async () => {
    await seedBatch('b-touch-closed', [CREATE_PLAN], 'CLOSED');

    await repo.touchBlock('b-touch-closed', NOW);

    const batch = await prisma.peopleImportBatch.findUniqueOrThrow({
      where: { id: 'b-touch-closed' },
    });
    expect(batch.lastBlockAt).toBeNull();
  });
});

describe('PeopleImportWriteRepository.finalizeRow: motivo longo', () => {
  it('finalizeRow corta o motivo em 200 caracteres sem partir um emoji', async () => {
    const [rowId] = await seedBatch('b-emoji', [CREATE_PLAN]);
    await reserve('b-emoji', 'ta');
    const reason = `${'x'.repeat(199)}\u{1F600}y`;

    await finalize(rowId, 'ta', { outcome: 'FAILED', reason, personId: null });

    expect((await rowById(rowId)).outcomeReason).toBe(
      `${'x'.repeat(199)}\u{1F600}`,
    );
  });
});
