import { Logger } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PeopleExportQuery } from '../../schemas/contracts/people-export.schema';
import type { DomainError } from '../../shared/errors/domain.error';
import { CSV_BOM } from '../../shared/spreadsheet/csv-writer';
import { PEOPLE_EXPORT_COLUMNS } from '../../shared/spreadsheet/people-columns';
import { findTeamActor } from '../team-whatsapp/team-actor.query';
import type { TeamActor } from '../team-whatsapp/team-whatsapp.policy';
import { peopleExportChange } from './export-trail';
import {
  exportShiftNotFound,
  peopleTooLarge,
  sectorOutOfReach,
} from './people-export.errors';
import { PEOPLE_DETAIL_PAGE } from './people-export.service';
import {
  MASKED,
  PHONE_NAME,
  TX,
  candidate,
  detail,
  exportKit,
  expectDomainError,
  teamActor,
  type ExportKitSetup,
} from './people-export.service.fixtures';

vi.mock('../team-whatsapp/team-actor.query', () => ({
  findTeamActor: vi.fn(),
}));

const TODAY = '2026-11-19';
const NOW = new Date('2026-11-19T15:00:00Z'); // 11:00 em Manaus
const ADMIN = teamActor('ADMIN');
const MANAGER = teamActor('SUPERVISOR', { managedSectorIds: ['s1', 's3'] });
const BLIND = teamActor('SUPERVISOR', {
  managedSectorIds: ['s1'],
  revoke: ['telefone.ver_completo'],
});
const QUERY: PeopleExportQuery = {
  format: 'csv',
  status: 'active',
  sectorId: undefined,
  shiftId: undefined,
};
const FORMATS = ['csv', 'xlsx'] as const;
const PAST = '2026-10-01';
/** Uma pessoa que, na data passada, estava em s1/t1 (as linhas de vínculo valem sempre). */
const PAST_DATA: ExportKitSetup['data'] = {
  candidates: [candidate({ id: 'p1', name: 'Ana' })],
  details: [detail({ id: 'p1' })],
  lines: {
    p1: [
      { sectorId: 's1', shiftId: 't1', levelId: 'n1', from: null, to: null },
    ],
  },
};
const HEADER = PEOPLE_EXPORT_COLUMNS.join(';');
const ANA_ROW =
  'M-100;Ana;(92) 99111-2008;Analista;Logística;Manhã;Pleno;Sim;;;;Ativa;Não';

type Run = ExportKitSetup & {
  actor?: TeamActor | null;
  query?: Partial<PeopleExportQuery>;
};

function run(opts: Run = {}) {
  const kit = exportKit(opts);
  const actor = opts.actor === undefined ? ADMIN : opts.actor;
  vi.mocked(findTeamActor).mockResolvedValue(actor);
  const go = (over: Partial<PeopleExportQuery> = {}) =>
    kit.service.exportPeople(
      'actor-1',
      { ...QUERY, ...opts.query, ...over },
      kit.sink,
    );
  return { ...kit, go };
}

/** `n` pessoas de nome igual ao id, para a ordem do índice ser a dos ids. */
function crowd(total: number): ExportKitSetup['data'] {
  const ids = Array.from(
    { length: total },
    (_, i) => `p${String(i).padStart(5, '0')}`,
  );
  return {
    candidates: ids.map((id) => candidate({ id, name: id })),
    details: ids.map((id) => detail({ id, name: id })),
  };
}

function trail(over: Partial<Parameters<typeof peopleExportChange>[0]> = {}) {
  return peopleExportChange({
    actorId: 'actor-1',
    format: 'csv',
    sector: null,
    shift: null,
    status: 'active',
    date: TODAY,
    rowCount: 0,
    phoneVisibility: 'full',
    ...over,
  });
}

async function csvLines(ended: Promise<Buffer>): Promise<string[]> {
  const text = (await ended).toString('utf8');
  expect(text.startsWith(CSV_BOM)).toBe(true);
  expect(text.endsWith('\r\n')).toBe(true);
  return text.slice(CSV_BOM.length).split('\r\n').slice(0, -1);
}

async function xlsxOf(ended: Promise<Buffer>): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load((await ended) as unknown as ArrayBuffer);
  return workbook;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('exportPeople: data de referência passada na trilha e no nome (DX11)', () => {
  it('a trilha grava a data pedida e o arquivo continua com o dia de hoje', async () => {
    const kit = run({ query: { date: PAST }, data: PAST_DATA });

    const count = await kit.go();
    await kit.ended;

    expect(count).toBe(1);
    expect(kit.audit.recordChange).toHaveBeenCalledWith(
      TX,
      trail({ date: PAST, rowCount: 1 }),
    );
    expect(kit.setHeader).toHaveBeenCalledWith(
      'Content-Disposition',
      `attachment; filename="pessoas-${TODAY}.csv"`,
    );
  });
});

describe('exportPeople: aba Instruções com os filtros usados (aceite 2)', () => {
  it('gestor, setor s1, turno t1, situação Todas e data passada aparecem nas linhas 2 a 6', async () => {
    const { go, ended } = run({
      actor: MANAGER,
      query: {
        format: 'xlsx',
        sectorId: 's1',
        shiftId: 't1',
        status: 'all',
        date: PAST,
      },
      data: PAST_DATA,
    });

    await go();

    const notes = (await xlsxOf(ended)).getWorksheet('Instruções')!;
    const cells = (row: number) => notes.getRow(row).values;
    expect(cells(2)).toEqual([undefined, 'Setor', 'Logística']);
    expect(cells(3)).toEqual([undefined, 'Turno', 'Manhã']);
    expect(cells(4)).toEqual([undefined, 'Situação', 'Todas']);
    expect(cells(5)).toEqual([undefined, 'Data de referência', '01/10/2026']);
    expect(notes.getCell('A6').value).toBe('Telefone');
    expect(notes.getCell('B6').value).toContain(
      'Completo só de pessoas sem acesso',
    );
  });
});

describe('exportPeople: CSV filtrado (aceite 1)', () => {
  it('aceite 1: CSV filtrado por setor e turno, com BOM, ; e CRLF, só as pessoas do filtro', async () => {
    const { go, ended } = run({
      query: { sectorId: 's1', shiftId: 't1' },
      data: {
        candidates: [
          candidate({ id: 'p1', name: 'Zélia' }),
          candidate({ id: 'p2', name: 'Ana' }),
          candidate({ id: 'p3', name: 'Bia', shiftId: 't2' }),
          candidate({ id: 'p4', name: 'Caio', sectorId: 's2' }),
        ],
        details: ['p1', 'p2', 'p3', 'p4'].map((id) => detail({ id })),
      },
    });

    const count = await go();

    expect(count).toBe(2);
    expect(await csvLines(ended)).toEqual([
      HEADER,
      ANA_ROW,
      ANA_ROW.replace('Ana', 'Zélia'),
    ]);
  });
});

describe('exportPeople: XLSX com abas (aceite 2)', () => {
  it('aceite 2: XLSX com as abas Pessoas e Instruções, a linha vazia no lugar', async () => {
    const { go, ended } = run({
      query: { format: 'xlsx' },
      data: { candidates: [candidate({ name: 'Ana' })], details: [detail()] },
    });

    await go();

    const workbook = await xlsxOf(ended);
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual([
      'Pessoas',
      'Instruções',
    ]);
    const people = workbook.getWorksheet('Pessoas')!;
    expect(people.getRow(1).values).toEqual([
      undefined,
      ...PEOPLE_EXPORT_COLUMNS,
    ]);
    expect(people.getCell('B2').value).toBe('Ana');
    expect(people.rowCount).toBe(2);
    const notes = workbook.getWorksheet('Instruções')!;
    expect(notes.getRow(1).values).toEqual([
      undefined,
      'Exportado em',
      '19/11/2026 11:00',
    ]);
    expect(notes.getRow(9).values).toEqual([]);
    expect(notes.getRow(10).values).toEqual([
      undefined,
      'Coluna',
      'Significado',
    ]);
    expect(notes.getCell('A11').value).toBe('matricula');
    expect(notes.rowCount).toBe(10 + PEOPLE_EXPORT_COLUMNS.length);
  });
});

describe('exportPeople: sem resultado e texto perigoso (DX8, DX15)', () => {
  const tricky = {
    candidates: [candidate({ name: '=CMD("x")' })],
    details: [detail({ jobTitle: 'Líder; "Turno A"\nNoite' })],
  };

  it('sem resultado: só o cabeçalho e trilha com rowCount 0', async () => {
    const { go, ended, audit, repo } = run({ data: { candidates: [] } });

    expect(await go()).toBe(0);

    expect(await csvLines(ended)).toEqual([HEADER]);
    expect(audit.recordChange).toHaveBeenCalledWith(TX, trail({ rowCount: 0 }));
    expect(repo.detailsByIds).not.toHaveBeenCalled();
  });

  it('nome com fórmula e função com ; aspas e quebra de linha: CSV com apóstrofo e aspas', async () => {
    const { go, ended } = run({ data: tricky });

    await go();

    const text = (await ended).toString('utf8');
    expect(text).toContain('"\'=CMD(""x"")"');
    expect(text).toContain('"Líder; ""Turno A""\nNoite"');
  });

  it('o mesmo texto no XLSX sai como texto, sem fórmula nem apóstrofo', async () => {
    const { go, ended } = run({ query: { format: 'xlsx' }, data: tricky });

    await go();

    const people = (await xlsxOf(ended)).getWorksheet('Pessoas')!;
    const name = people.getCell('B2');
    expect(name.type).toBe(ExcelJS.ValueType.String);
    expect(name.value).toBe('=CMD("x")');
    expect(people.getCell('D2').value).toBe('Líder; "Turno A"\nNoite');
  });
});

describe('exportPeople: recusa do plano e trilha que falha (DX9)', () => {
  const refusals: Array<[string, Run, DomainError]> = [
    ['403 sem alcance', { actor: null }, sectorOutOfReach()],
    ['404 turno', { query: { shiftId: 'nada' } }, exportShiftNotFound()],
    ['422 pessoas demais', { data: crowd(50_001) }, peopleTooLarge()],
  ];

  it.each(refusals)(
    'recusa do plano (%s) sobe sem trilha, sem header e sem byte',
    async (_name, setup, expected) => {
      const kit = run(setup);

      await expectDomainError(kit.go(), expected);

      expect(kit.prisma.$transaction).not.toHaveBeenCalled();
      expect(kit.audit.recordChange).not.toHaveBeenCalled();
      expect(kit.setHeader).not.toHaveBeenCalled();
      expect(kit.removeHeader).not.toHaveBeenCalled();
      expect(kit.write).not.toHaveBeenCalled();
    },
  );

  it('trilha que falha: o erro sobe, nenhum header de download nem byte', async () => {
    const failure = new Error('banco fora');
    const kit = run({ data: crowd(2), trailError: failure });

    await expect(kit.go()).rejects.toBe(failure);

    expect(kit.setHeader).not.toHaveBeenCalled();
    expect(kit.write).not.toHaveBeenCalled();
    expect(kit.repo.detailsByIds).not.toHaveBeenCalled();
  });
});

describe('exportPeople: ordem da trilha (DX9)', () => {
  const order = (fn: { mock: { invocationCallOrder: number[] } }) =>
    fn.mock.invocationCallOrder[0];

  it('trilha com filtros, data, quantidade e phoneVisibility, antes do primeiro header', async () => {
    const kit = run({
      query: { format: 'xlsx', sectorId: 's1', shiftId: 't1', status: 'all' },
      data: crowd(2),
    });

    await kit.go();
    await kit.ended;

    expect(kit.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(kit.audit.recordChange).toHaveBeenCalledTimes(1);
    expect(kit.audit.recordChange).toHaveBeenCalledWith(
      TX,
      trail({
        format: 'xlsx',
        sector: { id: 's1', name: 'Logística' },
        shift: { id: 't1', name: 'Manhã' },
        status: 'all',
        rowCount: 2,
      }),
    );
    expect(order(vi.mocked(findTeamActor))).toBeLessThan(
      order(kit.audit.recordChange),
    );
    expect(order(kit.audit.recordChange)).toBeLessThan(
      order(kit.repo.detailsByIds),
    );
    expect(order(kit.repo.detailsByIds)).toBeLessThan(order(kit.setHeader));
    expect(order(kit.setHeader)).toBeLessThan(order(kit.write));
  });
});

describe('exportPeople: trilha fora do envio e sem dado pessoal (DX13, GX8)', () => {
  it('headers e escritas só depois que a transação da trilha fechou', async () => {
    const kit = run({ data: crowd(2) });

    await kit.go();
    await kit.ended;

    expect(kit.headerSeen).not.toHaveLength(0);
    expect(kit.headerSeen).not.toContain(false);
    expect(kit.writeSeen).not.toHaveLength(0);
    expect(kit.writeSeen).not.toContain(false);
  });

  it.each([
    ['ADMIN', ADMIN, 'full'],
    ['gestor', MANAGER, 'partial'],
    ['sem a chave', BLIND, 'masked'],
  ] as const)('phoneVisibility de %s é %s', async (_name, actor, expected) => {
    const kit = run({ actor, data: crowd(1) });

    await kit.go();

    expect(kit.audit.recordChange).toHaveBeenCalledWith(
      TX,
      trail({ rowCount: 1, phoneVisibility: expected }),
    );
  });

  it('o evento não leva nome, telefone, matrícula nem id de pessoa', async () => {
    const kit = run({
      data: {
        candidates: [candidate({ id: 'pessoa-77', name: 'Ana Souza' })],
        details: [detail({ id: 'pessoa-77', registration: 'M-9' })],
      },
    });

    await kit.go();

    const logged = JSON.stringify(kit.audit.recordChange.mock.calls[0][1]);
    for (const personal of ['Ana', '+5592', '99111', 'M-9', 'pessoa-77']) {
      expect(logged).not.toContain(personal);
    }
  });
});

describe('exportPeople: id ausente e login ganho (DX4, aceite 3)', () => {
  const cellsOf = (line: string) => line.split(';');

  it('pessoa apagada ou que ganhou login entre as passadas: linha omitida ou mascarada, arquivo íntegro', async () => {
    const kit = run({
      actor: MANAGER,
      data: {
        candidates: [
          candidate({ id: 'p1', name: 'Bia' }),
          candidate({ id: 'p2', name: 'Carlos Dias' }),
          candidate({ id: 'p3', name: PHONE_NAME }),
          candidate({ id: 'p4', name: 'Ana' }),
        ],
        // fora da ordem do índice; p2 foi apagada; p3 ganhou login
        details: [
          detail({ id: 'p4' }),
          detail({ id: 'p3', name: PHONE_NAME, hasAccess: true }),
          detail({ id: 'p1' }),
        ],
      },
    });

    const count = await kit.go();

    const lines = await csvLines(kit.ended);
    const rows = lines.slice(1).map(cellsOf);
    expect(count).toBe(3);
    expect(lines[0]).toBe(HEADER);
    expect(rows.every((cells) => cells.length === 13)).toBe(true);
    expect(rows.map((cells) => cells[1])).toEqual([MASKED, 'Ana', 'Bia']);
    expect(rows.map((cells) => cells[2])).toEqual([
      MASKED,
      '(92) 99111-2008',
      '(92) 99111-2008',
    ]);
    expect(rows[0][12]).toBe('Sim');
    expect(kit.audit.recordChange).toHaveBeenCalledWith(
      TX,
      trail({ rowCount: 4, phoneVisibility: 'partial' }),
    );
  });
});

describe('exportPeople: blocos da segunda passada (DX4)', () => {
  it('lê os detalhes em blocos de 500, na ordem do índice, e escreve tudo', async () => {
    const kit = run({ data: crowd(1_001) });

    const count = await kit.go();

    const calls = kit.repo.detailsByIds.mock.calls;
    expect(calls.map(([ids]) => ids.length)).toEqual([
      PEOPLE_DETAIL_PAGE,
      PEOPLE_DETAIL_PAGE,
      1,
    ]);
    expect(calls[0][0][0]).toBe('p00000');
    expect(calls[1][0][0]).toBe(
      `p${String(PEOPLE_DETAIL_PAGE).padStart(5, '0')}`,
    );
    expect(count).toBe(1_001);
    expect(await csvLines(kit.ended)).toHaveLength(1_002);
  });
});

describe('exportPeople: destino fechado (DX10)', () => {
  it.each(FORMATS)(
    'destino fechado antes dos headers enviados (%s): remove o header de download e relança, sem pendurar',
    async (format) => {
      const kit = run({ query: { format }, data: crowd(1) });
      kit.sink.destroy();

      await expect(kit.go()).rejects.toThrow('destino fechado');

      expect(kit.removeHeader).toHaveBeenCalledWith('Content-Disposition');
    },
    3000,
  );

  it.each(FORMATS)(
    'destino fechado depois dos headers (%s): registra uma vez, não relança e não conta linha escrita',
    async (format) => {
      const logged = vi
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      const kit = run({ query: { format }, data: crowd(1) });
      Object.assign(kit.sink, { headersSent: true });
      kit.sink.destroy();

      expect(await kit.go()).toBe(0);

      expect(logged).toHaveBeenCalledTimes(1);
      logged.mockRestore();
    },
    3000,
  );
});

describe('exportPeople: erro de leitura no meio da escrita (DX10)', () => {
  it('erro de leitura no primeiro bloco: sobe como erro, sem header de download e sem byte', async () => {
    const failure = new Error('banco fora');
    const kit = run({ data: crowd(1) });
    kit.repo.detailsByIds.mockImplementationOnce(() => Promise.reject(failure));

    await expect(kit.go()).rejects.toBe(failure);

    expect(kit.setHeader).not.toHaveBeenCalled();
    expect(kit.write).not.toHaveBeenCalled();
  });

  it.each(FORMATS)(
    'erro de leitura no segundo bloco (%s): derruba a conexão sem relançar e sem texto de erro no arquivo',
    async (format) => {
      const logged = vi
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      const kit = run({
        query: { format },
        data: crowd(PEOPLE_DETAIL_PAGE + 1),
      });
      const first = kit.repo.detailsByIds.getMockImplementation()!;
      kit.repo.detailsByIds
        .mockImplementationOnce(first)
        .mockImplementationOnce(() => Promise.reject(new Error('banco fora')));

      expect(await kit.go()).toBe(PEOPLE_DETAIL_PAGE);

      expect(logged).toHaveBeenCalledTimes(1);
      expect(kit.sink.destroyed).toBe(true);
      expect(kit.removeHeader).not.toHaveBeenCalled();
      const sent = Buffer.concat(kit.chunks).toString('latin1');
      expect(sent).not.toMatch(/statusCode|banco fora|"code"/);
      logged.mockRestore();
    },
    3000,
  );
});

describe('exportPeople: nome do arquivo (DX11, GX6)', () => {
  const disposition = (name: string) => [
    'Content-Disposition',
    `attachment; filename="${name}"`,
  ];

  it('usa o dia de Manaus, não o de UTC', async () => {
    vi.setSystemTime(new Date('2026-11-20T03:30:00Z')); // 23:30 de 19/11 em Manaus
    const kit = run({ data: crowd(1) });

    await kit.go();

    expect(kit.setHeader).toHaveBeenCalledWith(
      ...disposition('pessoas-2026-11-19.csv'),
    );
  });

  it('XLSX leva a extensão do formato e o dia do plano, mesmo se a meia-noite passar durante a leitura', async () => {
    const kit = run({ query: { format: 'xlsx' }, data: crowd(1) });
    const read = kit.repo.detailsByIds.getMockImplementation()!;
    kit.repo.detailsByIds.mockImplementationOnce((ids) => {
      vi.setSystemTime(new Date('2026-11-20T05:00:00Z'));
      return read(ids);
    });

    await kit.go();

    expect(kit.setHeader).toHaveBeenCalledWith(
      ...disposition('pessoas-2026-11-19.xlsx'),
    );
  });
});
