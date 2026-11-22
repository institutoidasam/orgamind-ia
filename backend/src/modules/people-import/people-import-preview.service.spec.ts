import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ColumnMapping,
  RowClass,
} from '../../schemas/contracts/people-import.schema';
import { actorWith } from '../../shared/authz/actor.test-fixtures';
import type { PrismaService } from '../../shared/prisma/prisma.service';
import { readCsvSheet } from '../../shared/spreadsheet/csv-reader';
import { IMPORT_MAX_BYTES } from '../../shared/spreadsheet/sheet-data';
import { findTeamActor } from '../team-whatsapp/team-actor.query';
import type { TeamActor } from '../team-whatsapp/team-whatsapp.policy';
import type { BatchClassifier, BatchInput } from './batch-classifier';
import { suggestMapping } from './mapping';
import type { PeopleImportCloseRepository } from './people-import-close.repository';
import { PeopleImportPreviewService } from './people-import-preview.service';
import { PeopleImportQueryService } from './people-import-query.service';
import type {
  BatchRecord,
  NewBatch,
  PeopleImportRepository,
  RowRecord,
} from './people-import.repository';

vi.mock('../team-whatsapp/team-actor.query', () => ({
  findTeamActor: vi.fn(),
}));

vi.mock('../../shared/spreadsheet/csv-reader', async (importOriginal) => {
  const real =
    await importOriginal<
      typeof import('../../shared/spreadsheet/csv-reader')
    >();
  return { ...real, readCsvSheet: vi.fn(real.readCsvSheet) };
});

function teamActor(
  role: TeamActor['role'],
  change: Parameters<typeof actorWith>[1] = {},
  managedSectorIds: readonly string[] = ['s1'],
): TeamActor {
  return { ...actorWith(role, change), managedSectorIds };
}

const ADMIN = teamActor('ADMIN', { id: 'u-admin' });
const MANAGER = teamActor('SUPERVISOR', { id: 'u-manager' });
const NO_EDIT = teamActor('SUPERVISOR', {
  id: 'u-manager',
  revoke: ['pessoas.editar'],
});
const NO_SECTOR = teamActor('SUPERVISOR', { id: 'u-manager' }, []);
const NOW = new Date('2026-11-19T15:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const HEADERS = ['nome', 'celular', 'cargo', 'setor', 'fone2'];
const LINES = [
  'nome;celular;cargo;setor;fone2',
  'Ana Teste;+5592991110001;Auxiliar;Logística;',
  'Bruno Teste;+5592991110002;Motorista;Logística;+5592991110003',
];
const COUNTS: Record<RowClass, number> = {
  CREATE: 2,
  UPDATE: 0,
  UNCHANGED: 0,
  INVALID: 0,
  DUPLICATE: 0,
  CONFLICT: 0,
  IGNORED: 0,
};
const VERDICT = {
  classification: 'CREATE' as const,
  reasons: [],
  warnings: [],
  preview: null,
  plan: null,
  personId: null,
};
const NOT_FOUND = { code: 'people_import.batch_not_found', status: 404 };
const NOT_PREVIEW = { code: 'people_import.not_preview', status: 409 };
const DENIED = { code: 'auth.permission_denied', status: 403 };
const NO_MANAGED = { code: 'people_import.no_managed_sector', status: 403 };

function csvFile(lines: readonly string[], originalName = 'pessoas.csv') {
  const buffer = Buffer.from(`${lines.join('\n')}\n`, 'utf8');
  return { originalName, size: buffer.length, buffer };
}

async function xlsxFile(rows: string[][], originalName: string) {
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet('Pessoas').addRows(rows);
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  return { originalName, size: buffer.length, buffer };
}

function batchOf(over: Partial<BatchRecord> = {}): BatchRecord {
  return {
    id: 'b1',
    fileName: 'pessoas.csv',
    fileSize: 200,
    fileSha256: 'a'.repeat(64),
    format: 'csv',
    headers: HEADERS,
    mapping: suggestMapping(HEADERS),
    previewCounts: COUNTS,
    createdById: 'u-manager',
    status: 'PREVIEW',
    createdAt: new Date('2026-11-18T12:00:00Z'),
    confirmedById: null,
    confirmedAt: null,
    lastBlockAt: null,
    finishedAt: null,
    closedById: null,
    result: null,
    ...over,
  };
}

function storedRows(): RowRecord[] {
  return LINES.slice(1).map((line, index) => ({
    rowNumber: index + 2,
    cells: Object.fromEntries(
      line.split(';').map((cell, column) => [String(column), cell]),
    ),
    verdict: VERDICT,
  }));
}

function newBatch(batch: NewBatch): BatchRecord {
  return batchOf({ ...batch, id: 'b-new', createdAt: NOW });
}

type Store = Map<string, { batch: BatchRecord; rows: RowRecord[] }>;

/** Repositório em memória: só muda lote em prévia, como o real (T12). */
function fakeRepo(store: Store) {
  return {
    createBatch: vi.fn((batch: NewBatch, rows: readonly RowRecord[]) => {
      store.set('b-new', { batch: newBatch(batch), rows: [...rows] });
      return Promise.resolve('b-new');
    }),
    findBatch: vi.fn((id: string) =>
      Promise.resolve(store.get(id)?.batch ?? null),
    ),
    readRowCells: vi.fn((id: string) =>
      Promise.resolve(
        (store.get(id)?.rows ?? []).map(({ rowNumber, cells }) => ({
          rowNumber,
          cells,
        })),
      ),
    ),
    replaceRows: vi.fn(
      (
        id: string,
        input: Parameters<PeopleImportRepository['replaceRows']>[1],
      ) => {
        const entry = store.get(id);
        if (entry?.batch.status !== 'PREVIEW') return Promise.resolve(false);
        entry.batch = {
          ...entry.batch,
          mapping: input.mapping,
          previewCounts: input.previewCounts,
        };
        entry.rows = [...input.rows];
        return Promise.resolve(true);
      },
    ),
    deletePreview: vi.fn((id: string) =>
      Promise.resolve(
        store.get(id)?.batch.status === 'PREVIEW' && store.delete(id),
      ),
    ),
    deleteStalePreviews: vi.fn(() => Promise.resolve(0)),
    userNames: vi.fn(() => Promise.resolve(new Map<string, string | null>())),
  };
}

/** A consulta (T17) é a real; classificador e encerramento automático, falsos. */
function setup(batches: BatchRecord[] = []) {
  const store: Store = new Map(
    batches.map((batch) => [batch.id, { batch, rows: storedRows() }]),
  );
  const repo = fakeRepo(store);
  const classifier = {
    classify: vi.fn((input: BatchInput) =>
      Promise.resolve({
        rows: input.rows.map((row) => ({ ...row, verdict: VERDICT })),
        counts: COUNTS,
      }),
    ),
  };
  const confirm = { closeStale: vi.fn(() => Promise.resolve(0)) };
  const prisma = {} as PrismaService;
  const asRepo = repo as unknown as PeopleImportRepository;
  const query = new PeopleImportQueryService(
    prisma,
    asRepo,
    {} as PeopleImportCloseRepository,
  );
  const service = new PeopleImportPreviewService(
    prisma,
    asRepo,
    classifier as unknown as BatchClassifier,
    query,
  );
  Object.assign(service, { confirmService: confirm });
  return { service, store, repo, classifier, confirm };
}

type Fakes = ReturnType<typeof setup>;

function actorIs(actor: TeamActor): void {
  vi.mocked(findTeamActor).mockResolvedValue(actor);
}

function nothingWritten(fakes: Fakes): void {
  expect(fakes.repo.createBatch).not.toHaveBeenCalled();
  expect(fakes.repo.deleteStalePreviews).not.toHaveBeenCalled();
  expect(fakes.confirm.closeStale).not.toHaveBeenCalled();
}

function remapped(over: Partial<ColumnMapping> = {}): ColumnMapping {
  return { ...suggestMapping(HEADERS), phone: 4, ...over };
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  vi.mocked(findTeamActor).mockReset();
  vi.mocked(readCsvSheet).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('PeopleImportPreviewService.upload: log da falha inesperada (T16 M2)', () => {
  it('o log traz só o código, sem nome nem telefone do arquivo', async () => {
    const levels = ['log', 'warn', 'error', 'debug'] as const;
    const spies = levels.map((level) =>
      vi.spyOn(Logger.prototype, level).mockImplementation(() => undefined),
    );
    const fakes = setup();
    actorIs(ADMIN);
    vi.mocked(readCsvSheet).mockImplementationOnce(() => {
      throw new TypeError('Ana Teste +5592991110001');
    });
    await expect(
      fakes.service.upload('u-admin', csvFile(LINES)),
    ).rejects.toMatchObject({ code: 'people_import.unreadable' });
    const logged = JSON.stringify(spies.flatMap((spy) => spy.mock.calls));
    spies.forEach((spy) => spy.mockRestore());
    expect(logged).toContain('people_import.unreadable');
    expect(logged).not.toMatch(/Ana|Teste|5592991110001/u);
  });
});

describe('PeopleImportPreviewService.upload: leitura e lote (E2)', () => {
  it('envio: lê, sugere colunas, classifica e guarda com o SHA-256; devolve o resumo', async () => {
    const fakes = setup();
    actorIs(MANAGER);
    const file = csvFile(LINES);
    const summary = await fakes.service.upload('u-manager', file);
    const input = fakes.classifier.classify.mock.calls[0][0];
    expect(input.rows.map((row) => row.rowNumber)).toEqual([2, 3]);
    expect(input.rows[0].cells).toEqual({
      '0': 'Ana Teste',
      '1': '+5592991110001',
      '2': 'Auxiliar',
      '3': 'Logística',
      '4': '',
    });
    expect(input.actor).toMatchObject({ id: 'u-manager', reach: ['s1'] });
    expect(input.today).toBe('2026-11-19');
    expect(input.mapping).toMatchObject({ name: 0, phone: 1, jobTitle: 2 });
    expect(input.mapping.sector).toBe(3);
    const [batch, rows] = fakes.repo.createBatch.mock.calls[0];
    expect(batch).toEqual({
      fileName: 'pessoas.csv',
      fileSize: file.size,
      fileSha256: createHash('sha256').update(file.buffer).digest('hex'),
      format: 'csv',
      headers: HEADERS,
      mapping: input.mapping,
      previewCounts: COUNTS,
      createdById: 'u-manager',
    });
    expect(rows.map((row) => row.verdict)).toEqual([VERDICT, VERDICT]);
    expect(summary).toMatchObject({
      id: 'b-new',
      fileName: 'pessoas.csv',
      counts: COUNTS,
      mappingProblem: null,
      canDiscard: true,
    });
  });
});

describe('PeopleImportPreviewService.upload: nome do arquivo (EX4)', () => {
  it('envio guarda o nome do arquivo acentuado em UTF-8', async () => {
    const fakes = setup();
    actorIs(ADMIN);
    const latin1 = Buffer.from('Relatório São João.xlsx', 'utf8').toString(
      'latin1',
    );
    const rows = LINES.map((line) => line.split(';'));
    const summary = await fakes.service.upload(
      'u-admin',
      await xlsxFile(rows, latin1),
    );
    const [batch] = fakes.repo.createBatch.mock.calls[0];
    expect(batch).toMatchObject({
      fileName: 'Relatório São João.xlsx',
      format: 'xlsx',
      headers: HEADERS,
    });
    expect(summary.fileName).toBe('Relatório São João.xlsx');
  });
});

describe('PeopleImportPreviewService.upload: recusas (aceite 22/24, EX4)', () => {
  it('arquivo que não é csv nem xlsx: 422 invalid_file', async () => {
    const fakes = setup();
    actorIs(ADMIN);
    const invalid = { code: 'people_import.invalid_file', status: 422 };
    await expect(
      fakes.service.upload('u-admin', csvFile(LINES, 'pessoas.txt')),
    ).rejects.toMatchObject(invalid);
    await expect(
      fakes.service.upload('u-admin', csvFile(LINES, 'pessoas.xlsx')),
    ).rejects.toMatchObject(invalid);
    nothingWritten(fakes);
  });

  it('acima de 5 MB: 422 file_too_large', async () => {
    const fakes = setup();
    actorIs(ADMIN);
    const buffer = Buffer.alloc(IMPORT_MAX_BYTES + 1, 'a');
    await expect(
      fakes.service.upload('u-admin', {
        originalName: 'grande.csv',
        size: buffer.length,
        buffer,
      }),
    ).rejects.toMatchObject({ code: 'people_import.file_too_large' });
    nothingWritten(fakes);
  });
});

describe('PeopleImportPreviewService.upload: recusas da leitura (CX3)', () => {
  it('acima de 5.000 linhas: 422 com o texto da spec', async () => {
    const fakes = setup();
    actorIs(ADMIN);
    const many = Array.from({ length: 5_001 }, (_, i) => `Pessoa ${i};${i}`);
    await expect(
      fakes.service.upload('u-admin', csvFile(['nome;matricula', ...many])),
    ).rejects.toMatchObject({
      code: 'people_import.too_many_rows',
      status: 422,
      detail: 'A planilha tem linhas demais. Envie até 5.000 por vez.',
    });
    nothingWritten(fakes);
  });

  it('falha inesperada da leitura: 422 unreadable, sem gravar', async () => {
    const fakes = setup();
    actorIs(ADMIN);
    vi.mocked(readCsvSheet).mockImplementationOnce(() => {
      throw new TypeError('Ana Teste +5592991110001');
    });
    await expect(
      fakes.service.upload('u-admin', csvFile(LINES)),
    ).rejects.toMatchObject({ code: 'people_import.unreadable', status: 422 });
    nothingWritten(fakes);
  });
});

describe('PeopleImportPreviewService.upload: travas de quem não é ADMIN (GX6, EX32)', () => {
  it('quem não é ADMIN sem pessoas.editar: 403 no envio, sem ler o arquivo', async () => {
    const fakes = setup();
    // Arquivo que a leitura recusaria: o 403 vem antes de olhar o arquivo.
    const unreadable = csvFile(LINES, 'pessoas.txt');
    actorIs(NO_EDIT);
    await expect(
      fakes.service.upload('u-manager', unreadable),
    ).rejects.toMatchObject(DENIED);
    actorIs(NO_SECTOR);
    await expect(
      fakes.service.upload('u-manager', unreadable),
    ).rejects.toMatchObject(NO_MANAGED);
    expect(readCsvSheet).not.toHaveBeenCalled();
    nothingWritten(fakes);
  });
});

describe('PeopleImportPreviewService.upload: mapeamento incompleto (EX30, EX32)', () => {
  it('mapeamento incompleto: lote guardado sem classificação e com o aviso', async () => {
    const fakes = setup();
    actorIs(ADMIN);
    const summary = await fakes.service.upload(
      'u-admin',
      csvFile(['nome;observacao', 'Ana Teste;sem chave']),
    );
    expect(fakes.classifier.classify).not.toHaveBeenCalled();
    const [batch, rows] = fakes.repo.createBatch.mock.calls[0];
    expect(batch.previewCounts).toBeNull();
    expect(rows).toEqual([
      {
        rowNumber: 2,
        cells: { '0': 'Ana Teste', '1': 'sem chave' },
        verdict: null,
      },
    ]);
    expect(summary).toMatchObject({
      counts: null,
      mappingProblem:
        'Escolha a coluna de Nome e pelo menos uma entre Telefone e Matrícula.',
    });
  });

  it('quem não é ADMIN sem a coluna Setor: lote sem classificação com o aviso (EX32)', async () => {
    const fakes = setup();
    actorIs(MANAGER);
    const summary = await fakes.service.upload(
      'u-manager',
      csvFile(['nome;celular', 'Ana Teste;+5592991110001']),
    );
    expect(fakes.classifier.classify).not.toHaveBeenCalled();
    expect(summary.mappingProblem).toBe(
      'Escolha a coluna de Setor: quem não é administrador informa o setor em todas as linhas.',
    );
  });
});

describe('PeopleImportPreviewService.upload: limpeza no envio (EX14, EX13)', () => {
  it('envio apaga prévias com mais de 7 dias e encerra gravações paradas há mais de 7 dias', async () => {
    const fakes = setup();
    actorIs(ADMIN);
    await fakes.service.upload('u-admin', csvFile(LINES));
    expect(fakes.repo.deleteStalePreviews).toHaveBeenCalledWith(
      new Date(NOW.getTime() - 7 * DAY_MS),
    );
    expect(fakes.confirm.closeStale).toHaveBeenCalledWith(NOW);
    const created = fakes.repo.createBatch.mock.invocationCallOrder[0];
    expect(
      fakes.repo.deleteStalePreviews.mock.invocationCallOrder[0],
    ).toBeLessThan(created);
    expect(fakes.confirm.closeStale.mock.invocationCallOrder[0]).toBeLessThan(
      created,
    );
  });
});

describe('PeopleImportPreviewService.remap: quem e quando (aceite 13, EX25)', () => {
  it('aceite 13: remapear refaz a prévia; só quem enviou; só em prévia', async () => {
    const writing = batchOf({ id: 'b-writing', status: 'WRITING' });
    const alien = batchOf({ id: 'b-alien', createdById: 'u-other' });
    const fakes = setup([batchOf(), writing, alien]);
    actorIs(MANAGER);
    const counts = { ...COUNTS, CREATE: 1, UPDATE: 1 };
    fakes.classifier.classify.mockImplementationOnce((input: BatchInput) =>
      Promise.resolve({
        rows: input.rows.map((row) => ({ ...row, verdict: VERDICT })),
        counts,
      }),
    );
    const summary = await fakes.service.remap('u-manager', 'b1', remapped());
    const input = fakes.classifier.classify.mock.calls[0][0];
    expect(input.mapping.phone).toBe(4);
    expect(input.rows).toEqual(
      storedRows().map(({ rowNumber, cells }) => ({ rowNumber, cells })),
    );
    expect(fakes.store.get('b1')?.batch.mapping.phone).toBe(4);
    expect(summary).toMatchObject({ counts, mapping: { phone: 4 } });
    await expect(
      fakes.service.remap('u-manager', 'b-writing', remapped()),
    ).rejects.toMatchObject(NOT_PREVIEW);
    await expect(
      fakes.service.remap('u-manager', 'b-alien', remapped()),
    ).rejects.toMatchObject(NOT_FOUND);
    actorIs(ADMIN);
    await expect(
      fakes.service.remap('u-admin', 'b1', remapped()),
    ).rejects.toMatchObject({
      code: 'people_import.not_uploader',
      status: 403,
    });
    expect(fakes.repo.replaceRows).toHaveBeenCalledTimes(1);
  });
});

describe('PeopleImportPreviewService.remap: corrida com a confirmação (EX6)', () => {
  it('confirmação no meio do remapear: 409 not_preview', async () => {
    const fakes = setup([batchOf()]);
    actorIs(MANAGER);
    fakes.repo.replaceRows.mockResolvedValueOnce(false);
    await expect(
      fakes.service.remap('u-manager', 'b1', remapped()),
    ).rejects.toMatchObject(NOT_PREVIEW);
  });

  it('descarte no meio do remapear: 404', async () => {
    const fakes = setup([batchOf()]);
    actorIs(MANAGER);
    fakes.repo.replaceRows.mockImplementationOnce((id: string) => {
      fakes.store.delete(id);
      return Promise.resolve(false);
    });
    await expect(
      fakes.service.remap('u-manager', 'b1', remapped()),
    ).rejects.toMatchObject(NOT_FOUND);
  });
});

describe('PeopleImportPreviewService.remap: permissões de agora (EX6)', () => {
  it('remapear relê o ator: sem pessoas.editar agora, 403; sem setor agora, 403 no_managed_sector; nada muda', async () => {
    const fakes = setup([batchOf()]);
    actorIs(NO_EDIT);
    await expect(
      fakes.service.remap('u-manager', 'b1', remapped()),
    ).rejects.toMatchObject(DENIED);
    actorIs(NO_SECTOR);
    await expect(
      fakes.service.remap('u-manager', 'b1', remapped()),
    ).rejects.toMatchObject(NO_MANAGED);
    expect(fakes.classifier.classify).not.toHaveBeenCalled();
    expect(fakes.repo.replaceRows).not.toHaveBeenCalled();
    expect(fakes.store.get('b1')?.batch.mapping.phone).toBe(1);
  });

  it('remapear reclassifica com o alcance de agora', async () => {
    const fakes = setup([batchOf()]);
    actorIs(teamActor('SUPERVISOR', { id: 'u-manager' }, ['s2', 's3']));
    await fakes.service.remap('u-manager', 'b1', remapped());
    const input = fakes.classifier.classify.mock.calls[0][0];
    expect(input.actor).toMatchObject({ id: 'u-manager', reach: ['s2', 's3'] });
    expect(input.today).toBe('2026-11-19');
  });

  it('remapear incompleto: 422 e nada muda', async () => {
    const fakes = setup([batchOf()]);
    actorIs(MANAGER);
    await expect(
      fakes.service.remap('u-manager', 'b1', remapped({ sector: null })),
    ).rejects.toMatchObject({
      code: 'people_import.mapping_incomplete',
      status: 422,
      detail:
        'Escolha a coluna de Setor: quem não é administrador informa o setor em todas as linhas.',
    });
    expect(fakes.repo.readRowCells).not.toHaveBeenCalled();
    expect(fakes.repo.replaceRows).not.toHaveBeenCalled();
  });
});

describe('PeopleImportPreviewService.discard (EX14, EX25)', () => {
  it('descartar: lote alheio 404 para quem não é ADMIN; fora da prévia 409; apaga o lote e ele passa a responder 404', async () => {
    const writing = batchOf({ id: 'b-writing', status: 'WRITING' });
    const alien = batchOf({ id: 'b-alien', createdById: 'u-other' });
    const fakes = setup([batchOf(), writing, alien]);
    actorIs(MANAGER);
    await expect(
      fakes.service.discard('u-manager', 'b-alien'),
    ).rejects.toMatchObject(NOT_FOUND);
    await expect(
      fakes.service.discard('u-manager', 'b-writing'),
    ).rejects.toMatchObject(NOT_PREVIEW);
    expect(fakes.repo.deletePreview).not.toHaveBeenCalled();
    await fakes.service.discard('u-manager', 'b1');
    expect(fakes.store.has('b1')).toBe(false);
    await expect(
      fakes.service.discard('u-manager', 'b1'),
    ).rejects.toMatchObject(NOT_FOUND);
    actorIs(ADMIN);
    await fakes.service.discard('u-admin', 'b-alien');
    expect(fakes.store.has('b-alien')).toBe(false);
  });

  it('descartar junto com outro pedido: 404 se o lote sumiu, 409 se saiu da prévia', async () => {
    const fakes = setup([batchOf(), batchOf({ id: 'b2' })]);
    // Descartar não pede pessoas.editar: basta ver o lote (EX25).
    actorIs(NO_EDIT);
    fakes.repo.deletePreview.mockImplementationOnce((id: string) => {
      fakes.store.delete(id);
      return Promise.resolve(false);
    });
    await expect(
      fakes.service.discard('u-manager', 'b1'),
    ).rejects.toMatchObject(NOT_FOUND);
    fakes.repo.deletePreview.mockImplementationOnce((id: string) => {
      const entry = fakes.store.get(id);
      if (entry) entry.batch = { ...entry.batch, status: 'WRITING' };
      return Promise.resolve(false);
    });
    await expect(
      fakes.service.discard('u-manager', 'b2'),
    ).rejects.toMatchObject(NOT_PREVIEW);
  });
});
