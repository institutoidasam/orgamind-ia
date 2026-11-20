import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { deployMigrations } from '../../../test/migrations';
import type {
  ColumnMapping,
  RowClass,
} from '../../schemas/contracts/people-import.schema';
import type { PrismaService } from '../../shared/prisma/prisma.service';
import type { RowVerdict } from './import-person';
import {
  type NewBatch,
  PeopleImportRepository,
  type RowRecord,
} from './people-import.repository';

let postgres: StartedPostgreSqlContainer;
let prisma: PrismaClient;
let repo: PeopleImportRepository;

const NOW = new Date('2026-11-19T15:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const MAPPING: ColumnMapping = {
  registration: null,
  name: 0,
  phone: 1,
  jobTitle: null,
  sector: null,
  shift: null,
  level: null,
  authorization: null,
  authorizationSource: null,
  authorizationNote: null,
  authorizationDate: null,
};

const phone = (n: number) => `+559299111${String(n).padStart(4, '0')}`;
const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

function verdict(
  classification: RowClass,
  over: Partial<RowVerdict> = {},
): RowVerdict {
  return {
    classification,
    reasons: [],
    warnings: [],
    preview: null,
    plan: null,
    personId: null,
    ...over,
  };
}

function record(
  rowNumber: number,
  classification: RowClass | null,
  over: Partial<RowVerdict> = {},
): RowRecord {
  return {
    rowNumber,
    cells: { '0': `Pessoa ${rowNumber}`, '1': phone(rowNumber) },
    verdict: classification === null ? null : verdict(classification, over),
  };
}

function newBatch(over: Partial<NewBatch> = {}): NewBatch {
  return {
    fileName: 'pessoas.csv',
    fileSize: 120,
    fileSha256: 'a'.repeat(64),
    format: 'csv',
    headers: ['Nome', 'Telefone'],
    mapping: MAPPING,
    previewCounts: null,
    createdById: 'u-admin',
    ...over,
  };
}

async function seedBatch(
  id: string,
  over: Partial<Prisma.PeopleImportBatchUncheckedCreateInput> = {},
): Promise<void> {
  await prisma.peopleImportBatch.create({
    data: {
      id,
      fileName: 'pessoas.csv',
      fileSize: 120,
      fileSha256: 'b'.repeat(64),
      format: 'csv',
      headers: ['Nome', 'Telefone'],
      mapping: {},
      createdById: 'u-admin',
      ...over,
    },
  });
}

async function seedPerson(
  id: string,
  over: Partial<Prisma.UserUncheckedCreateInput> = {},
): Promise<void> {
  await prisma.user.create({
    data: {
      id,
      name: `Pessoa ${id}`,
      hasAccess: false,
      role: 'VIEWER',
      ...over,
    },
  });
}

const batchIds = async () =>
  (await prisma.peopleImportBatch.findMany()).map((batch) => batch.id).sort();

beforeAll(async () => {
  postgres = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('database_test')
    .withUsername(`user_${randomUUID().replaceAll('-', '')}`)
    .withPassword(randomUUID())
    .start();
  const databaseUrl = postgres.getConnectionUri();
  deployMigrations({ databaseUrl });
  prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  repo = new PeopleImportRepository(prisma as unknown as PrismaService);
  await seedStructure();
}, 240_000);

afterAll(async () => {
  await prisma?.$disconnect();
  await postgres?.stop();
});

beforeEach(async () => {
  await prisma.peopleImportBatch.deleteMany();
});

/** Setor, turno e nível, ativos e inativos, com ids fixos para os testes. */
async function seedStructure(): Promise<void> {
  await prisma.sector.createMany({
    data: [
      { id: 'sec-log', name: 'Logística', code: 'LOG' },
      { id: 'sec-old', name: 'Arquivo antigo', code: 'ANT', isActive: false },
    ],
  });
  const time = { startTime: '07:00', endTime: '13:00' };
  await prisma.shift.createMany({
    data: [
      { id: 'sh-manha', name: 'Manhã', sortOrder: 1, ...time },
      { id: 'sh-noite', name: 'Noite', sortOrder: 2, isActive: false, ...time },
    ],
  });
  await prisma.staffLevel.createMany({
    data: [
      { id: 'lv-pleno', name: 'Pleno', sortOrder: 1 },
      { id: 'lv-jr', name: 'Júnior', sortOrder: 2, isActive: false },
    ],
  });
}

const PLAN = {
  kind: 'create',
  keys: { registrationKey: null, phoneE164: phone(2) },
  input: { name: 'Pessoa 2', phone: phone(2) },
} as const;
const PREVIEW = { personName: null, diff: [] };

/** 1.050 linhas (passa do bloco de 1.000); as múltiplas de 3 são UPDATE. */
const pagedRows = () =>
  range(2, 1051).map((n) =>
    record(n, n % 3 === 0 ? 'UPDATE' : 'CREATE', {
      reasons: ['r'],
      preview: PREVIEW,
    }),
  );

describe('PeopleImportRepository.toWriteCount: linhas a gravar (T17 M1)', () => {
  it('conta só as linhas com estado de gravação do lote pedido', async () => {
    const rows = [2, 3, 4, 5].map((n) => record(n, 'CREATE'));
    const id = await repo.createBatch(newBatch(), rows);
    const other = await repo.createBatch(newBatch(), [record(2, 'CREATE')]);
    expect(await repo.toWriteCount(id)).toBe(0);

    await prisma.peopleImportRow.updateMany({
      where: { batchId: { in: [id, other] }, rowNumber: { in: [2, 3, 4] } },
      data: { writeState: 'PENDING' },
    });
    await prisma.peopleImportRow.updateMany({
      where: { batchId: id, rowNumber: 3 },
      data: { writeState: 'DONE' },
    });

    expect(await repo.toWriteCount(id)).toBe(3);
    expect(await repo.toWriteCount(other)).toBe(1);
  });
});

describe('PeopleImportRepository: criação e leitura das linhas', () => {
  it('createBatch grava lote e linhas; pageRows pagina 50 por vez em ordem de linha e filtra por classificação', async () => {
    const id = await repo.createBatch(newBatch(), pagedRows());

    expect(await repo.findBatch(id)).toMatchObject({
      id,
      status: 'PREVIEW',
      mapping: MAPPING,
      headers: ['Nome', 'Telefone'],
      confirmedById: null,
      result: null,
    });
    const first = await repo.pageRows(id, { page: 1 });
    expect(first.total).toBe(1050);
    expect(first.items.map((r) => r.rowNumber)).toEqual(range(2, 51));
    expect(first.items[0]).toEqual({
      rowNumber: 2,
      cells: { '0': 'Pessoa 2', '1': phone(2) },
      classification: 'CREATE',
      reasons: ['r'],
      warnings: [],
      preview: PREVIEW,
    });
    const last = await repo.pageRows(id, { page: 21 });
    expect(last.items.map((r) => r.rowNumber)).toEqual(range(1002, 1051));
    const query = { page: 1, classification: 'UPDATE' } as const;
    const updates = await repo.pageRows(id, query);
    expect(updates.total).toBe(350);
    expect(updates.items.map((r) => r.rowNumber)).toEqual(
      range(3, 150).filter((n) => n % 3 === 0),
    );
  });
});

describe('PeopleImportRepository: plano guardado', () => {
  it('createBatch guarda plano e pessoa como vieram, sem interpretar', async () => {
    const row = record(2, 'CREATE', { plan: PLAN, personId: 'p-1' });
    const id = await repo.createBatch(newBatch(), [row, record(3, null)]);

    const stored = await prisma.peopleImportRow.findMany({
      where: { batchId: id },
      orderBy: { rowNumber: 'asc' },
    });
    expect(stored[0]).toMatchObject({ plan: PLAN, personId: 'p-1' });
    expect(stored[1]).toMatchObject({
      classification: null,
      plan: null,
      preview: null,
      reasons: [],
    });
  });
});

describe('PeopleImportRepository: remapear', () => {
  it('replaceRows só em prévia; troca classificação e contagens', async () => {
    const id = await repo.createBatch(
      newBatch({ mapping: { ...MAPPING, phone: null } }),
      [record(2, null), record(3, null), record(4, null)],
    );
    const counts = { CREATE: 1, INVALID: 1 } as Record<RowClass, number>;
    const input = {
      mapping: MAPPING,
      previewCounts: counts,
      rows: [record(2, 'CREATE'), record(3, 'INVALID', { reasons: ['x'] })],
    };

    expect(await repo.replaceRows(id, input)).toBe(true);
    expect(await repo.findBatch(id)).toMatchObject({
      mapping: MAPPING,
      previewCounts: counts,
    });
    const page = await repo.pageRows(id, { page: 1 });
    expect(page.items.map((r) => [r.rowNumber, r.classification])).toEqual([
      [2, 'CREATE'],
      [3, 'INVALID'],
    ]);
    await prisma.peopleImportBatch.update({
      where: { id },
      data: { status: 'WRITING' },
    });
    expect(await repo.replaceRows(id, { ...input, rows: [] })).toBe(false);
    expect((await repo.pageRows(id, { page: 1 })).total).toBe(2);
    expect(await repo.replaceRows('b-inexistente', input)).toBe(false);
  });
});

describe('PeopleImportRepository: lotes da lista', () => {
  it('listBatches: ADMIN todos, demais os seus, mais recentes primeiro', async () => {
    await prisma.peopleImportBatch.createMany({
      data: range(1, 22).map((n) => ({
        id: `b-ana-${n}`,
        fileName: 'ana.csv',
        fileSize: 1,
        fileSha256: 'c'.repeat(64),
        format: 'csv',
        headers: [],
        mapping: {},
        createdById: 'u-ana',
        createdAt: new Date(NOW.getTime() - n * 60_000),
      })),
    });
    await seedBatch('b-bia', { createdById: 'u-bia', createdAt: NOW });

    const all = await repo.listBatches({ createdById: null, page: 1 });
    expect(all.total).toBe(23);
    expect(all.items).toHaveLength(20);
    expect(all.items[0].id).toBe('b-bia');
    const own = await repo.listBatches({ createdById: 'u-ana', page: 2 });
    expect(own.total).toBe(22);
    expect(own.items.map((b) => b.id)).toEqual(['b-ana-21', 'b-ana-22']);
    const bia = await repo.listBatches({ createdById: 'u-bia', page: 1 });
    expect(bia.items.map((b) => b.id)).toEqual(['b-bia']);
  });
});

describe('PeopleImportRepository: limpeza das prévias', () => {
  const rowsIn = (batchId: string) =>
    prisma.peopleImportRow.count({ where: { batchId } });

  async function seedWithRow(id: string, over: object): Promise<void> {
    await seedBatch(id, over);
    await prisma.peopleImportRow.create({
      data: { batchId: id, rowNumber: 2 },
    });
  }

  it('deleteStalePreviews apaga só prévias com mais de 7 dias, com as linhas', async () => {
    const old = new Date(NOW.getTime() - 8 * DAY);
    await seedWithRow('b-old', { createdAt: old });
    await seedWithRow('b-recent', {
      createdAt: new Date(NOW.getTime() - 6 * DAY),
    });
    await seedWithRow('b-old-writing', { createdAt: old, status: 'WRITING' });

    const cutoff = new Date(NOW.getTime() - 7 * DAY);
    expect(await repo.deleteStalePreviews(cutoff)).toBe(1);
    expect(await batchIds()).toEqual(['b-old-writing', 'b-recent']);
    expect(await rowsIn('b-old')).toBe(0);
    expect(await rowsIn('b-recent')).toBe(1);
  });

  it('deletePreview só apaga prévia, com as linhas', async () => {
    await seedWithRow('b-prev', {});
    await seedWithRow('b-done', { status: 'COMPLETED' });

    expect(await repo.deletePreview('b-done')).toBe(false);
    expect(await repo.deletePreview('b-inexistente')).toBe(false);
    expect(await repo.deletePreview('b-prev')).toBe(true);
    expect(await batchIds()).toEqual(['b-done']);
    expect(await rowsIn('b-prev')).toBe(0);
  });
});

const FULL_PERSON = {
  id: 'p-reg',
  name: 'Pessoa p-reg',
  phoneE164: null,
  registration: 'M-001',
  registrationKey: 'M001',
  jobTitle: 'Auxiliar',
  sectorId: 'sec-log',
  shiftId: 'sh-manha',
  levelId: 'lv-pleno',
  authorization: {
    status: 'AUTORIZADO',
    source: 'TERMO_ASSINADO',
    note: 'Termo 12',
    date: '2026-10-01',
  },
  isActive: true,
  hasAccess: false,
};

async function seedKeyPeople(): Promise<void> {
  await seedPerson('p-reg', {
    registration: 'M-001',
    registrationKey: 'M001',
    sectorId: 'sec-log',
    shiftId: 'sh-manha',
    levelId: 'lv-pleno',
    jobTitle: 'Auxiliar',
    contactAuthorization: 'AUTORIZADO',
    authorizationSource: 'TERMO_ASSINADO',
    authorizationNote: 'Termo 12',
    authorizationDate: new Date('2026-10-01T00:00:00.000Z'),
  });
  await seedPerson('p-tel-a', { phoneE164: '+5592991110002' });
  await seedPerson('p-tel-b', { phoneE164: '+559291110003' });
  await seedPerson('p-fora', { phoneE164: '+5592991110004' });
}

describe('PeopleImportRepository.findPeopleByKeys: chaves', () => {
  it('findPeopleByKeys acha por matrícula e por qualquer grafia do telefone', async () => {
    await seedKeyPeople();

    const found = await repo.findPeopleByKeys({
      registrationKeys: ['M001'],
      phones: ['+5592991110002', '+5592991110003', '+559291110003'],
    });

    expect(found.map((p) => p.id).sort()).toEqual([
      'p-reg',
      'p-tel-a',
      'p-tel-b',
    ]);
    expect(found.find((p) => p.id === 'p-reg')).toEqual(FULL_PERSON);
  });

  it('findPeopleByKeys consulta em blocos: acha a chave que vem depois das 1.000 primeiras', async () => {
    await seedPerson('p-bloco', {
      registrationKey: 'BL1',
      phoneE164: '+5592991110021',
    });
    await seedPerson('p-bloco-tel', { phoneE164: '+5592991110022' });
    const fake = (prefix: string) => range(1, 2100).map((n) => `${prefix}${n}`);

    const found = await repo.findPeopleByKeys({
      registrationKeys: [...fake('X'), 'BL1'],
      phones: [...fake('+0'), '+5592991110022'],
    });

    expect(found.map((p) => p.id).sort()).toEqual(['p-bloco', 'p-bloco-tel']);
  });
});

describe('PeopleImportRepository.findPeopleByKeys: id e telefone', () => {
  it('findPeopleByKeys acha pelo id; phones vazio não consulta telefone', async () => {
    await seedPerson('p-id', {
      registrationKey: 'ID1',
      phoneE164: '+5592991110011',
    });
    await seedPerson('p-so-tel', { phoneE164: '+5592991110012' });

    const byId = await repo.findPeopleByKeys({
      registrationKeys: [],
      phones: [],
      ids: ['p-id'],
    });
    expect(byId.map((p) => p.id)).toEqual(['p-id']);
    const both = await repo.findPeopleByKeys({
      registrationKeys: ['ID1'],
      phones: [],
      ids: ['p-id'],
    });
    expect(both.map((p) => p.id)).toEqual(['p-id']);

    const noPhone = await repo.findPeopleByKeys({
      registrationKeys: ['SEM-ESSA'],
      phones: [],
    });
    expect(noPhone).toEqual([]);
    const withPhone = await repo.findPeopleByKeys({
      registrationKeys: ['SEM-ESSA'],
      phones: ['+5592991110012'],
    });
    expect(withPhone.map((p) => p.id)).toEqual(['p-so-tel']);
    expect(
      await repo.findPeopleByKeys({ registrationKeys: [], phones: [] }),
    ).toEqual([]);
  });
});

describe('PeopleImportRepository: catálogo e nomes', () => {
  it('loadCatalog traz setores, turnos e níveis, ativos e inativos, com o código do setor', async () => {
    const catalog = await repo.loadCatalog();

    expect(catalog.sector).toEqual(
      expect.arrayContaining([
        { id: 'sec-log', name: 'Logística', code: 'LOG', isActive: true },
        { id: 'sec-old', name: 'Arquivo antigo', code: 'ANT', isActive: false },
      ]),
    );
    expect(catalog.shift).toEqual(
      expect.arrayContaining([
        { id: 'sh-manha', name: 'Manhã', code: null, isActive: true },
        { id: 'sh-noite', name: 'Noite', code: null, isActive: false },
      ]),
    );
    expect(catalog.level).toEqual(
      expect.arrayContaining([
        { id: 'lv-pleno', name: 'Pleno', code: null, isActive: true },
        { id: 'lv-jr', name: 'Júnior', code: null, isActive: false },
      ]),
    );
  });

  it('userNames devolve o nome de cada pessoa achada, inclusive nulo', async () => {
    await seedPerson('p-nome', { name: 'Ana Souza' });
    await seedPerson('p-sem-nome', { name: null });

    const names = await repo.userNames(['p-nome', 'p-sem-nome', 'p-ninguem']);

    expect(names).toEqual(
      new Map([
        ['p-nome', 'Ana Souza'],
        ['p-sem-nome', null],
      ]),
    );
    expect(await repo.userNames([])).toEqual(new Map());
  });
});

type ReportSeed = Partial<Prisma.PeopleImportRowCreateManyInput>;

/** Linhas 2 a 9 do lote `b-report`: quatro entram no relatório, quatro não. */
async function seedReportRows(): Promise<void> {
  await seedBatch('b-report');
  const row = (rowNumber: number, over: ReportSeed) => ({
    batchId: 'b-report',
    rowNumber,
    cells: { '0': `Pessoa ${rowNumber}` },
    ...over,
  });
  const written = { writeState: 'DONE' as const };
  await prisma.peopleImportRow.createMany({
    data: [
      row(8, {
        ...written,
        classification: 'UPDATE',
        outcome: 'NOT_WRITTEN',
        outcomeReason: 'Não gravada: gravação encerrada',
      }),
      row(2, {
        classification: 'INVALID',
        reasons: ['Nome inválido'],
        cells: Prisma.DbNull,
      }),
      row(3, { ...written, classification: 'CREATE', outcome: 'CREATED' }),
      row(4, {
        ...written,
        classification: 'UPDATE',
        outcome: 'FAILED',
        outcomeReason: 'Não foi possível gravar esta linha.',
      }),
      row(5, { classification: 'UNCHANGED' }),
      row(6, { classification: 'DUPLICATE', reasons: ['a', 'b'] }),
      row(7, { classification: 'CONFLICT' }),
      row(9, { classification: 'IGNORED' }),
    ],
  });
}

describe('PeopleImportRepository: linhas do relatório', () => {
  it('reportRows traz inválidas, duplicadas, conflitos, falhas e não gravadas em ordem de linha', async () => {
    await seedReportRows();

    const report = await repo.reportRows('b-report', 0, 500);

    expect(report.map((r) => r.rowNumber)).toEqual([2, 4, 6, 7, 8]);
    expect(report[0]).toEqual({
      rowNumber: 2,
      cells: null,
      reasons: ['Nome inválido'],
      outcomeReason: null,
    });
    expect(report[1]).toEqual({
      rowNumber: 4,
      cells: { '0': 'Pessoa 4' },
      reasons: [],
      outcomeReason: 'Não foi possível gravar esta linha.',
    });
    expect(report[2].reasons).toEqual(['a', 'b']);
    const next = await repo.reportRows('b-report', 4, 2);
    expect(next.map((r) => r.rowNumber)).toEqual([6, 7]);
  });
});
