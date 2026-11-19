import { PassThrough } from 'node:stream';
import { Logger } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import { describe, expect, it, vi } from 'vitest';
import type { ScheduleExportQuery } from '../../schemas/contracts/people-export.schema';
import type {
  BoardRow,
  DaySituationContract,
  StaffScheduleBoard,
} from '../../schemas/contracts/staff-schedule.schema';
import type { AuditService } from '../../shared/audit/audit.service';
import type { PrismaService } from '../../shared/prisma/prisma.service';
import { CSV_BOM } from '../../shared/spreadsheet/csv-writer';
import type { DownloadSink } from '../../shared/spreadsheet/download';
import { scheduleForbidden } from '../staff-schedule/staff-schedule.errors';
import type { StaffScheduleService } from '../staff-schedule/staff-schedule.service';
import { scheduleExportChange } from './export-trail';
import { ScheduleExportService } from './schedule-export.service';

const FROM = '2026-11-19';
const TO = '2026-11-21';
const query: ScheduleExportQuery = {
  format: 'csv',
  sectorId: 'prod',
  from: FROM,
  to: TO,
};

const WORK_PROD: DaySituationContract = {
  kind: 'WORK',
  sectorId: 'prod',
  shiftId: 'noite',
  source: 'CYCLE',
};
const WORK_LOG: DaySituationContract = { ...WORK_PROD, sectorId: 'log' };
const OFF: DaySituationContract = {
  kind: 'OFF',
  reason: 'DAY_OFF',
  source: 'CYCLE',
};
const VACATION: DaySituationContract = {
  kind: 'OFF',
  reason: 'VACATION',
  source: 'EXCEPTION',
};
const NONE: DaySituationContract = { kind: 'NONE' };

function day(date: string, situation: DaySituationContract) {
  return { date, situation, exceptionId: null };
}

function makeRow(part: Partial<BoardRow> & { userId: string }): BoardRow {
  return {
    name: part.userId,
    jobTitle: null,
    fromOtherSector: false,
    canEdit: false,
    profileShiftId: null,
    schedule: null,
    days: [],
    ...part,
  };
}

function makeBoard(rows: BoardRow[], truncated = false): StaffScheduleBoard {
  return {
    sectorId: 'prod',
    from: FROM,
    to: TO,
    today: FROM,
    sectors: [{ id: 'log', name: 'Logística' }],
    shifts: [
      {
        id: 'noite',
        name: 'Noite',
        startTime: '19:00',
        endTime: '07:00',
        isActive: true,
      },
    ],
    rows,
    exceptions: [],
    truncated,
  };
}

/** `probe` diz se a transação já fechou: guarda o que cada header e escrita viu. */
function makeSink(probe: () => boolean) {
  const headerSeen: boolean[] = [];
  const writeSeen: boolean[] = [];
  const setHeader = vi.fn(() => {
    headerSeen.push(probe());
  });
  const removeHeader = vi.fn();
  const sink = Object.assign(
    new PassThrough({
      transform(chunk: Buffer, _encoding, done) {
        writeSeen.push(probe());
        done(null, chunk);
      },
    }),
    { setHeader, removeHeader, headersSent: false },
  );
  const chunks: Buffer[] = [];
  sink.on('data', (chunk: Buffer) => chunks.push(chunk));
  const ended = new Promise<Buffer>((resolve) =>
    sink.on('end', () => resolve(Buffer.concat(chunks))),
  );
  return {
    sink: sink as DownloadSink,
    write: vi.spyOn(sink, 'write'),
    setHeader,
    removeHeader,
    headerSeen,
    writeSeen,
    ended,
  };
}

type Setup = {
  board?: StaffScheduleBoard;
  boardError?: Error;
  sectorName?: string | null;
  trailError?: Error;
};

function setup(opts: Setup = {}) {
  const schedule = {
    board: vi.fn(() =>
      opts.boardError
        ? Promise.reject(opts.boardError)
        : Promise.resolve(opts.board ?? makeBoard([])),
    ),
  };
  const tx = { closed: false };
  const prisma = {
    $transaction: vi.fn(async (fn: (tx: object) => Promise<void>) => {
      await fn({});
      tx.closed = true;
    }),
    sector: {
      findUnique: vi.fn(() =>
        Promise.resolve(
          opts.sectorName === null
            ? null
            : { name: opts.sectorName ?? 'Produção Norte' },
        ),
      ),
    },
  };
  const audit = {
    recordChange: vi.fn(() =>
      opts.trailError ? Promise.reject(opts.trailError) : Promise.resolve(),
    ),
  };
  const service = new ScheduleExportService(
    prisma as unknown as PrismaService,
    schedule as unknown as StaffScheduleService,
    audit as unknown as AuditService,
  );
  return { service, schedule, prisma, audit, ...makeSink(() => tx.closed) };
}

function expectedTrail(rowCount: number, format: 'csv' | 'xlsx' = 'csv') {
  return scheduleExportChange({
    actorId: 'ator-1',
    format,
    sector: { id: 'prod', name: 'Produção Norte' },
    from: FROM,
    to: TO,
    rowCount,
  });
}

async function csvLines(ended: Promise<Buffer>): Promise<string[]> {
  const text = (await ended).toString('utf8');
  expect(text.startsWith(CSV_BOM)).toBe(true);
  return text.slice(CSV_BOM.length).split('\r\n').slice(0, -1);
}

const ana = makeRow({
  userId: 'u1',
  name: 'Ana Souza',
  jobTitle: 'Operadora',
  days: [day(FROM, WORK_PROD), day('2026-11-20', OFF), day(TO, NONE)],
});
const visitor = makeRow({
  userId: 'u2',
  name: '•••• 0001',
  fromOtherSector: true,
  days: [day(TO, WORK_LOG), day('2026-11-20', VACATION), day(FROM, WORK_PROD)],
});

describe('ScheduleExportService conteúdo', () => {
  it('aceite 7: cabeçalho nome, funcao, visitante e um dia por coluna; células com os textos do quadro', async () => {
    const { service, sink, ended } = setup({ board: makeBoard([ana]) });

    const count = await service.exportSchedule('ator-1', query, sink);

    expect(count).toBe(1);
    expect(await csvLines(ended)).toEqual([
      'nome;funcao;visitante;19/11/2026;20/11/2026;21/11/2026',
      'Ana Souza;Operadora;Não;Noite;Folga;',
    ]);
  });

  it('visitante Sim para quem é de outro setor; nome como veio do quadro; célula pela data do dia', async () => {
    const { service, sink, ended } = setup({
      board: makeBoard([ana, visitor]),
    });

    await service.exportSchedule('ator-1', query, sink);

    expect((await csvLines(ended)).slice(1)).toEqual([
      'Ana Souza;Operadora;Não;Noite;Folga;',
      '•••• 0001;;Sim;Noite;Férias;Em Logística',
    ]);
  });
});

describe('ScheduleExportService sem pessoas e XLSX', () => {
  it('setor sem pessoas no período: só o cabeçalho, com trilha de rowCount 0', async () => {
    const { service, sink, ended, audit } = setup();

    const count = await service.exportSchedule('ator-1', query, sink);

    expect(count).toBe(0);
    expect(await csvLines(ended)).toEqual([
      'nome;funcao;visitante;19/11/2026;20/11/2026;21/11/2026',
    ]);
    expect(audit.recordChange).toHaveBeenCalledWith({}, expectedTrail(0));
  });

  it('XLSX com a aba Escala e células como texto', async () => {
    const { service, sink, ended } = setup({ board: makeBoard([ana]) });

    await service.exportSchedule('ator-1', { ...query, format: 'xlsx' }, sink);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load((await ended) as unknown as ArrayBuffer);
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual(['Escala']);
    const sheet = workbook.getWorksheet('Escala')!;
    expect(sheet.getRow(1).values).toEqual([
      undefined,
      'nome',
      'funcao',
      'visitante',
      '19/11/2026',
      '20/11/2026',
      '21/11/2026',
    ]);
    expect(sheet.getCell('D2').value).toBe('Noite');
    expect(sheet.getCell('D2').type).toBe(ExcelJS.ValueType.String);
  });
});

describe('ScheduleExportService autorização do quadro', () => {
  it('chama o quadro com o ator de quem pediu e o período pedido', async () => {
    const { service, sink, schedule } = setup();

    await service.exportSchedule('ator-1', query, sink);

    expect(schedule.board).toHaveBeenCalledWith('ator-1', {
      sectorId: 'prod',
      from: FROM,
      to: TO,
    });
  });

  it('quadro recusado não grava trilha nem header, e o erro do quadro sobe como veio', async () => {
    const denied = scheduleForbidden();
    const { service, sink, audit, prisma, write, setHeader } = setup({
      boardError: denied,
    });

    await expect(service.exportSchedule('ator-1', query, sink)).rejects.toBe(
      denied,
    );

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(audit.recordChange).not.toHaveBeenCalled();
    expect(setHeader).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it('quadro cortado responde 422 sem trilha', async () => {
    const { service, sink, audit, write, setHeader } = setup({
      board: makeBoard([ana], true),
    });

    await expect(
      service.exportSchedule('ator-1', query, sink),
    ).rejects.toMatchObject({ code: 'export.too_large', status: 422 });

    expect(audit.recordChange).not.toHaveBeenCalled();
    expect(setHeader).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });
});

describe('ScheduleExportService recusas antes da trilha', () => {
  it('setor que sumiu entre o quadro e o nome: 404 sem trilha nem header', async () => {
    const { service, sink, audit, setHeader } = setup({ sectorName: null });

    await expect(
      service.exportSchedule('ator-1', query, sink),
    ).rejects.toMatchObject({ code: 'export.sector_not_found', status: 404 });

    expect(audit.recordChange).not.toHaveBeenCalled();
    expect(setHeader).not.toHaveBeenCalled();
  });

  it('trilha que falha: o erro sobe, sem header de download e sem byte', async () => {
    const failure = new Error('banco fora');
    const { service, sink, write, setHeader } = setup({
      board: makeBoard([ana]),
      trailError: failure,
    });

    await expect(service.exportSchedule('ator-1', query, sink)).rejects.toBe(
      failure,
    );

    expect(setHeader).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });
});

describe('ScheduleExportService trilha e nome do arquivo', () => {
  it('trilha com formato, setor, período e quantidade, antes do primeiro header', async () => {
    const { service, sink, audit, schedule, write, setHeader, ended } = setup({
      board: makeBoard([ana, visitor]),
    });

    await service.exportSchedule('ator-1', query, sink);
    await ended;

    expect(audit.recordChange).toHaveBeenCalledWith({}, expectedTrail(2));
    const order = (fn: { mock: { invocationCallOrder: number[] } }) =>
      fn.mock.invocationCallOrder[0];
    expect(order(schedule.board)).toBeLessThan(order(audit.recordChange));
    expect(order(audit.recordChange)).toBeLessThan(order(setHeader));
    expect(order(setHeader)).toBeLessThan(order(write));
  });

  it('nome do arquivo usa o setor reduzido e o período', async () => {
    const { service, sink, setHeader, ended } = setup();

    await service.exportSchedule('ator-1', { ...query, format: 'xlsx' }, sink);
    await ended;

    expect(setHeader).toHaveBeenCalledWith(
      'Content-Disposition',
      'attachment; filename="escala-producao-norte-2026-11-19-a-2026-11-21.xlsx"',
    );
  });
});

describe('ScheduleExportService falha no meio da escrita', () => {
  it('destino fechado antes dos headers enviados: remove o header de download e relança', async () => {
    const { service, sink, removeHeader } = setup({ board: makeBoard([ana]) });
    sink.destroy();

    await expect(service.exportSchedule('ator-1', query, sink)).rejects.toThrow(
      'destino fechado',
    );

    expect(removeHeader).toHaveBeenCalledWith('Content-Disposition');
  });

  it('destino fechado depois dos headers: registra, não relança e não conta linha escrita', async () => {
    const logged = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const { service, sink } = setup({ board: makeBoard([ana]) });
    Object.assign(sink, { headersSent: true });
    sink.destroy();

    const count = await service.exportSchedule('ator-1', query, sink);

    expect(count).toBe(0);
    expect(logged).toHaveBeenCalledTimes(1);
    logged.mockRestore();
  });
});

describe('ScheduleExportService nome que é e-mail', () => {
  it('colega com login convidado e sem nome: a coluna nome sai vazia e o e-mail não vai ao arquivo', async () => {
    const invited = makeRow({
      userId: 'u3',
      name: 'maria@exemplo.com.br',
      jobTitle: 'Técnica',
      days: [day(FROM, WORK_PROD)],
    });
    const { service, sink, ended } = setup({
      board: makeBoard([invited, visitor]),
    });

    await service.exportSchedule('ator-1', query, sink);

    expect((await csvLines(ended)).slice(1)).toEqual([
      ';Técnica;Não;Noite;;',
      '•••• 0001;;Sim;Noite;Férias;Em Logística',
    ]);
    expect((await ended).toString('utf8')).not.toContain('@');
  });
});

describe('ScheduleExportService envio fora da transação', () => {
  it('headers e primeira escrita só depois que a transação da trilha fechou', async () => {
    const { service, sink, headerSeen, writeSeen, ended } = setup({
      board: makeBoard([ana]),
    });

    await service.exportSchedule('ator-1', query, sink);
    await ended;

    expect(headerSeen).not.toHaveLength(0);
    expect(headerSeen).not.toContain(false);
    expect(writeSeen).not.toHaveLength(0);
    expect(writeSeen).not.toContain(false);
  });
});

describe('ScheduleExportService destino fechado em XLSX', () => {
  const xlsx = { ...query, format: 'xlsx' as const };

  it('antes dos headers enviados: remove o header de download e relança, sem pendurar', async () => {
    const { service, sink, removeHeader } = setup({ board: makeBoard([ana]) });
    sink.destroy();

    await expect(service.exportSchedule('ator-1', xlsx, sink)).rejects.toThrow(
      'destino fechado',
    );

    expect(removeHeader).toHaveBeenCalledWith('Content-Disposition');
  }, 3000);

  it('depois dos headers: registra uma vez, não relança e não conta linha escrita', async () => {
    const logged = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const { service, sink } = setup({ board: makeBoard([ana]) });
    Object.assign(sink, { headersSent: true });
    sink.destroy();

    const count = await service.exportSchedule('ator-1', xlsx, sink);

    expect(count).toBe(0);
    expect(logged).toHaveBeenCalledTimes(1);
    logged.mockRestore();
  }, 3000);
});
