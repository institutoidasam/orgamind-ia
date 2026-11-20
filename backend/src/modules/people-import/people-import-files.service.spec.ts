import * as ExcelJS from 'exceljs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  IMPORT_FIELDS,
  type ColumnMapping,
} from '../../schemas/contracts/people-import.schema';
import { actorWith } from '../../shared/authz/actor.test-fixtures';
import type { PrismaService } from '../../shared/prisma/prisma.service';
import { CSV_BOM } from '../../shared/spreadsheet/csv-writer';
import { PEOPLE_TEMPLATE_COLUMNS } from '../../shared/spreadsheet/people-columns';
import { makeSink } from '../people-export/people-export.service.fixtures';
import { findTeamActor } from '../team-whatsapp/team-actor.query';
import type { TeamActor } from '../team-whatsapp/team-whatsapp.policy';
import type { PeopleImportCloseRepository } from './people-import-close.repository';
import {
  PeopleImportFilesService,
  REPORT_PAGE_SIZE,
} from './people-import-files.service';
import { PeopleImportQueryService } from './people-import-query.service';
import type {
  BatchRecord,
  PeopleImportRepository,
  ReportRow,
} from './people-import.repository';

vi.mock('../team-whatsapp/team-actor.query', () => ({
  findTeamActor: vi.fn(),
}));

const NOW = new Date('2026-11-19T15:00:00Z');
// Quem enviou o lote: gestor com a chave de importar (a matriz inicial não a dá).
const OWNER = {
  ...actorWith('SUPERVISOR', { id: 'u-owner', grant: ['pessoas.importar'] }),
  managedSectorIds: ['s1'],
};
const DENIED = { code: 'auth.permission_denied', status: 403 };
const ADMIN = { ...actorWith('ADMIN', { id: 'u-root' }), managedSectorIds: [] };
const NOT_FOUND = { code: 'people_import.batch_not_found', status: 404 };
// "Observação" (coluna 2) não está mapeada: nunca pode sair no relatório.
const HEADERS = ['Nome completo', 'Celular', 'Observação', 'Matrícula'];
const MAPPING = {
  ...Object.fromEntries(IMPORT_FIELDS.map((field) => [field, null])),
  name: 0,
  phone: 1,
  registration: 3,
} as ColumnMapping;

function batchOf(over: Partial<BatchRecord> = {}): BatchRecord {
  return {
    ...{ id: 'lote-1', status: 'PREVIEW', format: 'csv', headers: HEADERS },
    ...{ fileName: 'equipe.csv', fileSize: 512, fileSha256: 'f'.repeat(64) },
    ...{ mapping: MAPPING, previewCounts: null, createdById: 'u-owner' },
    ...{ createdAt: NOW, confirmedById: null, confirmedAt: null },
    ...{ lastBlockAt: null, finishedAt: null, closedById: null, result: null },
    ...over,
  };
}

function reportRow(
  rowNumber: number,
  over: Partial<ReportRow> = {},
): ReportRow {
  const cells = {
    '0': `Pessoa ${rowNumber}`,
    '1': '',
    '2': 'segredo',
    '3': '',
  };
  return { rowNumber, cells, reasons: [], outcomeReason: null, ...over };
}

/** Serviço com repositórios em memória e o `visibleBatch` real da T17 (GX9). */
function filesKit(
  input: { batch?: BatchRecord | null; rows?: ReportRow[] } = {},
) {
  const batch = input.batch === undefined ? batchOf() : input.batch;
  const rows = input.rows ?? [];
  const repo = {
    findBatch: vi.fn((id: string) =>
      Promise.resolve(batch?.id === id ? batch : null),
    ),
    reportRows: vi.fn((_id: string, after: number, take: number) =>
      Promise.resolve(
        rows.filter((row) => row.rowNumber > after).slice(0, take),
      ),
    ),
  };
  const closeRepo = { settleExpired: vi.fn(() => Promise.resolve(0)) };
  const prisma = {} as PrismaService;
  const typedRepo = repo as unknown as PeopleImportRepository;
  const typedClose = closeRepo as unknown as PeopleImportCloseRepository;
  const query = new PeopleImportQueryService(prisma, typedRepo, typedClose);
  const service = new PeopleImportFilesService(
    prisma,
    typedRepo,
    typedClose,
    query,
  );
  return { service, repo, closeRepo, ...makeSink() };
}

function actingAs(actor: TeamActor): void {
  vi.mocked(findTeamActor).mockResolvedValue(actor);
}

async function csvLines(ended: Promise<Buffer>): Promise<string[]> {
  const text = (await ended).toString('utf8');
  expect(text.startsWith(CSV_BOM)).toBe(true);
  expect(text.endsWith('\r\n')).toBe(true);
  return text.slice(CSV_BOM.length).split('\r\n').slice(0, -1);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('PeopleImportFilesService.template: falha antes dos headers (GX10, T18)', () => {
  it('erro antes dos headers: desfaz os de download, relança e nada sai no corpo', async () => {
    const kit = filesKit();
    kit.setHeader.mockImplementationOnce(() => {
      throw new Error('falha ao montar os headers');
    });
    await expect(kit.service.template('csv', kit.sink)).rejects.toThrow(
      'falha ao montar os headers',
    );
    expect(kit.removeHeader).toHaveBeenCalledWith('Content-Disposition');
    expect(kit.removeHeader).toHaveBeenCalledWith('Content-Type');
    expect(kit.chunks).toHaveLength(0);
  });
});

describe('PeopleImportFilesService.template: modelo (EX24)', () => {
  it('aceite 12: modelo CSV com BOM, ;, cabeçalhos do modelo e linha EXEMPLO', async () => {
    const kit = filesKit();
    await kit.service.template('csv', kit.sink);
    const lines = await csvLines(kit.ended);
    expect(lines).toEqual([
      PEOPLE_TEMPLATE_COLUMNS.join(';'),
      'EXEMPLO;Maria Exemplo;(92) 99111-0000;Auxiliar;Nome do setor;Nome do turno;Nome do nível;Sim;Termo assinado;;19/11/2026',
    ]);
    expect(kit.setHeader).toHaveBeenCalledWith(
      'Content-Disposition',
      'attachment; filename="modelo-importacao-pessoas.csv"',
    );
    expect(kit.setHeader).toHaveBeenCalledWith(
      'Content-Type',
      'text/csv; charset=utf-8',
    );
  });

  it('modelo XLSX com abas Pessoas e Instruções', async () => {
    const kit = filesKit();
    await kit.service.template('xlsx', kit.sink);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load((await kit.ended) as unknown as ArrayBuffer);
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual([
      'Pessoas',
      'Instruções',
    ]);
    const people = workbook.getWorksheet('Pessoas');
    expect(people?.getCell('A1').text).toBe('matricula');
    expect(people?.getCell('A2').text).toBe('EXEMPLO');
    expect(people?.getCell('K2').text).toBe('19/11/2026');
    const rules = workbook.getWorksheet('Instruções');
    expect(rules?.getCell('A3').text).toContain(
      '(quem não vê telefone completo: só pela matrícula)',
    );
    expect(kit.setHeader).toHaveBeenCalledWith(
      'Content-Disposition',
      'attachment; filename="modelo-importacao-pessoas.xlsx"',
    );
  });
});

describe('PeopleImportFilesService.errorReport: conteúdo (EX23)', () => {
  it('aceite 11: relatório traz linha, colunas mapeadas com o cabeçalho original e motivo', async () => {
    const invalid = reportRow(2, {
      cells: {
        '0': 'Ana Teste',
        '1': '92 99111-0001',
        '2': 'segredo',
        '3': 'M-7',
      },
      reasons: ['Nome obrigatório.', 'Telefone inválido.'],
    });
    const duplicate = reportRow(5, { reasons: ['Linha repetida no arquivo.'] });
    const kit = filesKit({ rows: [invalid, duplicate] });
    actingAs(OWNER);
    await kit.service.errorReport('u-owner', 'lote-1', kit.sink);
    const lines = await csvLines(kit.ended);
    expect(lines).toEqual([
      'linha;Nome completo;Celular;Matrícula;motivo',
      '2;Ana Teste;92 99111-0001;M-7;"Nome obrigatório.; Telefone inválido."',
      '5;Pessoa 5;;;Linha repetida no arquivo.',
    ]);
    expect(lines.join('\n')).not.toMatch(/Observação|segredo/);
    expect(kit.setHeader).toHaveBeenCalledWith(
      'Content-Disposition',
      'attachment; filename="erros-importacao-2026-11-19.csv"',
    );
  });

  it('relatório: telefone como veio e fórmula protegida', async () => {
    const row = reportRow(3, {
      cells: { '0': '=HYPERLINK("x")', '1': '+5592991110002', '3': '@M1' },
      reasons: ['Telefone inválido.'],
    });
    const kit = filesKit({ rows: [row] });
    actingAs(OWNER);
    await kit.service.errorReport('u-owner', 'lote-1', kit.sink);
    const [, line] = await csvLines(kit.ended);
    expect(line).toBe(
      `3;"'=HYPERLINK(""x"")";'+5592991110002;'@M1;Telefone inválido.`,
    );
  });
});

describe('PeopleImportFilesService.errorReport: gravação e páginas (EX13, EX23)', () => {
  it('relatório inclui falhas e não gravadas', async () => {
    const failed = reportRow(4, {
      outcomeReason: 'O telefone já pertence a outra pessoa cadastrada',
    });
    const closed = reportRow(9, {
      cells: null,
      outcomeReason: 'Não gravada: gravação encerrada',
    });
    const kit = filesKit({
      batch: batchOf({ status: 'CLOSED' }),
      rows: [failed, closed],
    });
    actingAs(OWNER);
    await kit.service.errorReport('u-owner', 'lote-1', kit.sink);
    expect((await csvLines(kit.ended)).slice(1)).toEqual([
      '4;Pessoa 4;;;O telefone já pertence a outra pessoa cadastrada',
      '9;;;;Não gravada: gravação encerrada',
    ]);
    expect(kit.closeRepo.settleExpired).toHaveBeenCalledWith('lote-1', NOW);
    expect(
      kit.closeRepo.settleExpired.mock.invocationCallOrder[0],
    ).toBeLessThan(kit.repo.reportRows.mock.invocationCallOrder[0]);
  });

  it('lê em páginas de 500 até a última, em ordem de linha', async () => {
    const rows = Array.from({ length: REPORT_PAGE_SIZE + 1 }, (_, i) =>
      reportRow(i + 2, { reasons: ['Telefone inválido.'] }),
    );
    const kit = filesKit({ rows });
    actingAs(ADMIN);
    await kit.service.errorReport('u-root', 'lote-1', kit.sink);
    expect(await csvLines(kit.ended)).toHaveLength(REPORT_PAGE_SIZE + 2);
    expect(kit.repo.reportRows.mock.calls).toEqual([
      ['lote-1', 0, 500],
      ['lote-1', 501, 500],
    ]);
    expect(kit.closeRepo.settleExpired).not.toHaveBeenCalled();
  });
});

describe('PeopleImportFilesService.errorReport: quem baixa (GX9, E7)', () => {
  it('relatório de lote alheio: 404 sem header de download', async () => {
    const kit = filesKit({ batch: batchOf({ createdById: 'u-other' }) });
    actingAs(OWNER);
    await expect(
      kit.service.errorReport('u-owner', 'lote-1', kit.sink),
    ).rejects.toMatchObject(NOT_FOUND);
    await expect(
      kit.service.errorReport('u-owner', 'lote-inexistente', kit.sink),
    ).rejects.toMatchObject(NOT_FOUND);
    expect(kit.setHeader).not.toHaveBeenCalled();
    expect(kit.repo.reportRows).not.toHaveBeenCalled();
    expect(kit.chunks).toHaveLength(0);
  });

  it('ADMIN baixa o relatório do lote de outra pessoa', async () => {
    const row = reportRow(2, { reasons: ['Telefone inválido.'] });
    const kit = filesKit({
      batch: batchOf({ createdById: 'u-other' }),
      rows: [row],
    });
    actingAs(ADMIN);
    await kit.service.errorReport('u-root', 'lote-1', kit.sink);
    expect((await csvLines(kit.ended))[1]).toBe(
      '2;Pessoa 2;;;Telefone inválido.',
    );
  });

  it('sem pessoas.importar ou inativo: 403 sem header de download', async () => {
    const kit = filesKit();
    const keyless = actorWith('SUPERVISOR', { id: 'u-owner' });
    const actors: TeamActor[] = [
      { ...keyless, managedSectorIds: ['s1'] },
      { ...OWNER, isActive: false },
    ];
    for (const actor of actors) {
      actingAs(actor);
      await expect(
        kit.service.errorReport('u-owner', 'lote-1', kit.sink),
      ).rejects.toMatchObject(DENIED);
    }
    expect(kit.setHeader).not.toHaveBeenCalled();
    expect(kit.repo.findBatch).not.toHaveBeenCalled();
  });
});

describe('PeopleImportFilesService.errorReport: falha antes dos headers (GX10)', () => {
  it('falha ao ler a 1ª página: erro sobe e nenhum header de download fica', async () => {
    const kit = filesKit();
    kit.repo.reportRows.mockRejectedValueOnce(new Error('banco fora'));
    actingAs(OWNER);
    await expect(
      kit.service.errorReport('u-owner', 'lote-1', kit.sink),
    ).rejects.toThrow('banco fora');
    expect(kit.setHeader).not.toHaveBeenCalled();
    expect(kit.chunks).toHaveLength(0);
  });
});
