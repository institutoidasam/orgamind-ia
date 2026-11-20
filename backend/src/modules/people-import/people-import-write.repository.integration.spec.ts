import { randomUUID } from 'node:crypto';
import {
  type PeopleImportRowClass,
  type PeopleImportStatus,
  type Prisma,
  PrismaClient,
} from '@prisma/client';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { deployMigrations } from '../../../test/migrations';
import {
  type ColumnMapping,
  IMPORT_FIELDS,
} from '../../schemas/contracts/people-import.schema';
import type { PrismaService } from '../../shared/prisma/prisma.service';
import { PeopleImportWriteRepository } from './people-import-write.repository';
import {
  PeopleImportRepository,
  type RowRecord,
} from './people-import.repository';

let postgres: StartedPostgreSqlContainer;
let prisma: PrismaClient;
let repo: PeopleImportWriteRepository;
let importRepo: PeopleImportRepository;

const NOW = new Date('2026-11-19T15:00:00.000Z');
// Coluna 2 (CPF) é a única não mapeada: some de todas as linhas ao confirmar.
const CLASSES: PeopleImportRowClass[] = [
  'CREATE',
  'CREATE',
  'UPDATE',
  'UPDATE',
  'UNCHANGED',
  'INVALID',
  'IGNORED',
  'DUPLICATE',
  'CONFLICT',
];

type ConfirmInput = Parameters<PeopleImportWriteRepository['confirm']>[0];

function mappingOf(over: Partial<ColumnMapping>): ColumnMapping {
  const none = Object.fromEntries(IMPORT_FIELDS.map((field) => [field, null]));
  return { ...(none as ColumnMapping), ...over };
}

// O mapeamento do lote: "Nome" e "Telefone"; a coluna 2 (CPF) fica de fora.
const MAPPING = mappingOf({ name: 0, phone: 1 });
// Mapeamento que a tela validou antes de outra aba remapear: usava a coluna 2.
const MAPPING_WITH_CPF = mappingOf({ name: 0, phone: 1, registration: 2 });

// Colunas mapeadas ("Nome" e "Telefone"); a 2 (CPF) não é mapeada.
const mappedCells = (rowNumber: number) => ({
  '0': `Pessoa ${rowNumber}`,
  '1': `+559299111000${rowNumber % 10}`,
});

const seededCells = (rowNumber: number) => ({
  ...mappedCells(rowNumber),
  '2': `cpf-ficticio-${rowNumber}`,
});

function seedRow(
  classification: PeopleImportRowClass,
  index: number,
): Prisma.PeopleImportRowCreateWithoutBatchInput {
  const rowNumber = index + 2;
  return {
    rowNumber,
    classification,
    cells: seededCells(rowNumber),
    reasons: ['Nome inválido'],
    preview: { personName: null, diff: [] },
    plan: { kind: 'create', keys: {}, input: { name: 'x', phone: '+5592' } },
  };
}

async function seedBatch(
  id: string,
  over: {
    status?: PeopleImportStatus;
    createdById?: string;
    mapping?: ColumnMapping;
  } = {},
): Promise<void> {
  await prisma.peopleImportBatch.create({
    data: {
      id,
      fileName: 'pessoas.csv',
      fileSize: 120,
      fileSha256: 'a'.repeat(64),
      format: 'csv',
      headers: ['Nome', 'Telefone', 'CPF'],
      mapping: MAPPING,
      createdById: 'u-admin',
      ...over,
      rows: { create: CLASSES.map(seedRow) },
    },
  });
}

function confirmInput(
  batchId: string,
  over: Partial<ConfirmInput> = {},
): ConfirmInput & { trail: ReturnType<typeof vi.fn> } {
  return {
    batchId,
    actorId: 'u-admin',
    now: NOW,
    createNew: true,
    updateExisting: true,
    excludedRows: [],
    mapping: MAPPING,
    ...over,
    trail: vi.fn().mockResolvedValue(undefined),
  };
}

async function rowsOf(batchId: string) {
  return prisma.peopleImportRow.findMany({
    where: { batchId },
    orderBy: { rowNumber: 'asc' },
  });
}

/** Lote e linhas como foram semeados: nada confirmado, limpo nem marcado. */
async function expectUntouched(
  batchId: string,
  status: PeopleImportStatus = 'PREVIEW',
): Promise<void> {
  const batch = await prisma.peopleImportBatch.findUniqueOrThrow({
    where: { id: batchId },
  });
  expect(batch).toMatchObject({ status, confirmedById: null });
  const changed = (await rowsOf(batchId)).filter(
    (row) =>
      row.writeState !== null ||
      row.cells === null ||
      row.plan === null ||
      row.preview === null,
  );
  expect(changed).toEqual([]);
}

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
  importRepo = new PeopleImportRepository(prisma as unknown as PrismaService);
}, 240_000);

afterAll(async () => {
  await prisma?.$disconnect();
  await postgres?.stop();
});

/** Lote ainda em prévia com o mapeamento novo; nenhuma linha marcada nem limpa. */
async function expectStillPreview(
  batchId: string,
  rowNumbers: number[],
): Promise<void> {
  const batch = await prisma.peopleImportBatch.findUniqueOrThrow({
    where: { id: batchId },
  });
  expect(batch).toMatchObject({
    status: 'PREVIEW',
    confirmedById: null,
    mapping: MAPPING,
  });
  const rows = await rowsOf(batchId);
  expect(rows.map((row) => [row.writeState, row.cells])).toEqual(
    rowNumbers.map((n) => [null, seededCells(n)]),
  );
}

// A confirmação parada na trava do lote, que o remapear ainda segura.
async function waitForBlockedConfirm(): Promise<void> {
  await vi.waitFor(
    async () => {
      const [{ waiting }] = await prisma.$queryRaw<{ waiting: bigint }[]>`
        SELECT count(*) AS waiting FROM pg_stat_activity WHERE wait_event_type = 'Lock'`;
      expect(Number(waiting)).toBeGreaterThan(0);
    },
    { timeout: 4000, interval: 20 },
  );
}

describe('PeopleImportWriteRepository.confirm: remapear no meio (EX6, EX14)', () => {
  it('remapear commitado depois da leitura do lote: preview_changed e nada muda', async () => {
    await seedBatch('b-remapped', { mapping: MAPPING_WITH_CPF });
    // a tela leu e validou MAPPING_WITH_CPF; outra aba remapeia antes do confirm
    const rows: RowRecord[] = [2, 3].map((rowNumber) => ({
      rowNumber,
      cells: seededCells(rowNumber),
      verdict: {
        classification: 'CREATE',
        reasons: [],
        warnings: [],
        preview: null,
        plan: null,
        personId: null,
      },
    }));
    const remap = { mapping: MAPPING, previewCounts: null, rows };
    expect(await importRepo.replaceRows('b-remapped', remap)).toBe(true);
    const input = confirmInput('b-remapped', { mapping: MAPPING_WITH_CPF });

    expect(await repo.confirm(input)).toBe('preview_changed');

    expect(input.trail).not.toHaveBeenCalled();
    await expectStillPreview('b-remapped', [2, 3]);
  });

  it('remapear em andamento: a confirmação espera, relê o lote e devolve preview_changed', async () => {
    await seedBatch('b-racing', { mapping: MAPPING_WITH_CPF });
    const input = confirmInput('b-racing', { mapping: MAPPING_WITH_CPF });
    let pending: ReturnType<typeof repo.confirm> | undefined;

    // o primeiro passo do replaceRows: trava o lote em prévia e troca o mapeamento
    await prisma.$transaction(async (tx) => {
      await tx.peopleImportBatch.updateMany({
        where: { id: 'b-racing', status: 'PREVIEW' },
        data: { mapping: MAPPING },
      });
      pending = repo.confirm(input);
      await waitForBlockedConfirm();
    });

    expect(await pending).toBe('preview_changed');
    expect(input.trail).not.toHaveBeenCalled();
    await expectStillPreview(
      'b-racing',
      CLASSES.map((_, index) => index + 2),
    );
  });
});

describe('PeopleImportWriteRepository.confirm: seleção', () => {
  it('confirm: marca PENDING só nas linhas escolhidas e devolve as contagens', async () => {
    await seedBatch('b-select');
    const input = confirmInput('b-select', {
      updateExisting: false,
      excludedRows: [3],
    });

    const result = await repo.confirm(input);

    expect(result).toEqual({ toCreate: 1, toUpdate: 0 });
    expect(input.trail).toHaveBeenCalledTimes(1);
    expect(input.trail.mock.calls[0][1]).toEqual({ toCreate: 1, toUpdate: 0 });
    const pending = (await rowsOf('b-select'))
      .filter((row) => row.writeState === 'PENDING')
      .map((row) => row.rowNumber);
    expect(pending).toEqual([2]);
    const batch = await prisma.peopleImportBatch.findUniqueOrThrow({
      where: { id: 'b-select' },
    });
    expect(batch).toMatchObject({
      status: 'WRITING',
      confirmedById: 'u-admin',
      confirmedAt: NOW,
      lastBlockAt: NOW,
    });
  });
});

describe('PeopleImportWriteRepository.confirm: recusas', () => {
  it('confirm de quem não enviou ou de lote fora de PREVIEW devolve not_preview e não muda nada', async () => {
    await seedBatch('b-other-author');
    await seedBatch('b-already-writing', { status: 'WRITING' });
    const foreign = confirmInput('b-other-author', { actorId: 'u-outro' });
    const writing = confirmInput('b-already-writing');

    expect(await repo.confirm(foreign)).toBe('not_preview');
    expect(await repo.confirm(writing)).toBe('not_preview');

    expect(foreign.trail).not.toHaveBeenCalled();
    expect(writing.trail).not.toHaveBeenCalled();
    await expectUntouched('b-other-author');
    await expectUntouched('b-already-writing', 'WRITING');
  });

  it('confirm sem nada escolhido devolve nothing_selected e não muda o lote', async () => {
    await seedBatch('b-nothing');
    const input = confirmInput('b-nothing', {
      createNew: false,
      updateExisting: false,
    });

    expect(await repo.confirm(input)).toBe('nothing_selected');

    expect(input.trail).not.toHaveBeenCalled();
    await expectUntouched('b-nothing');
  });
});

describe('PeopleImportWriteRepository.confirm: uma vez só', () => {
  it('confirm: duas confirmações simultâneas, só uma muda o lote e grava a trilha', async () => {
    await seedBatch('b-double');
    const trail = vi.fn().mockResolvedValue(undefined);
    const input = { ...confirmInput('b-double'), trail };

    const results = await Promise.all([
      repo.confirm(input),
      repo.confirm(input),
    ]);

    expect(results).toContain('not_preview');
    expect(results).toContainEqual({ toCreate: 2, toUpdate: 2 });
    expect(trail).toHaveBeenCalledTimes(1);
    const pending = (await rowsOf('b-double')).filter(
      (row) => row.writeState === 'PENDING',
    );
    expect(pending).toHaveLength(4);
  });

  it('confirm: se a trilha falha, o lote volta a PREVIEW e nada é limpo', async () => {
    await seedBatch('b-trail-fails');
    const input = confirmInput('b-trail-fails');
    input.trail.mockRejectedValue(new Error('trilha fora do ar'));

    await expect(repo.confirm(input)).rejects.toThrow('trilha fora do ar');

    await expectUntouched('b-trail-fails');
  });
});

describe('PeopleImportWriteRepository.confirm: limpeza (aceite 26)', () => {
  it('aceite 26: confirmar apaga as colunas não mapeadas e o conteúdo das linhas fora da gravação', async () => {
    await seedBatch('b-clean');

    await repo.confirm(confirmInput('b-clean', { excludedRows: [3] }));

    const rows = await rowsOf('b-clean');
    const pick = (numbers: number[]) =>
      rows.filter((row) => numbers.includes(row.rowNumber));
    // vão ser gravadas (PENDING): colunas mapeadas e plano
    expect(pick([2, 4, 5]).map((r) => [r.cells, r.plan !== null])).toEqual(
      [2, 4, 5].map((n) => [mappedCells(n), true]),
    );
    // desmarcada, Sem alteração, Ignorada: nada do conteúdo
    expect(pick([3, 6, 8]).map((r) => [r.cells, r.plan])).toEqual([
      [null, null],
      [null, null],
      [null, null],
    ]);
    // erro: colunas mapeadas e motivo, sem plano
    expect(pick([7, 9, 10]).map((r) => [r.cells, r.plan, r.reasons])).toEqual(
      [7, 9, 10].map((n) => [mappedCells(n), null, ['Nome inválido']]),
    );
  });

  it('confirmar anula o preview de todas as linhas, inclusive as que vão ser gravadas', async () => {
    await seedBatch('b-preview');

    await repo.confirm(confirmInput('b-preview'));

    const rows = await rowsOf('b-preview');
    expect(rows).toHaveLength(9);
    expect(rows.every((row) => row.preview === null)).toBe(true);
  });
});
