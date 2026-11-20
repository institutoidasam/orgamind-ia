import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RowClass } from '../../schemas/contracts/people-import.schema';
import { actorWith } from '../../shared/authz/actor.test-fixtures';
import { PERMISSION_DENIED_TEXT } from '../../shared/authz/permissions';
import type { PrismaService } from '../../shared/prisma/prisma.service';
import { findTeamActor } from '../team-whatsapp/team-actor.query';
import type { TeamActor } from '../team-whatsapp/team-whatsapp.policy';
import type { ImportResultCounts, RowOutcome } from './import-person';
import { importReason } from './import-trail';
import { suggestMapping } from './mapping';
import type { PeopleImportCloseRepository } from './people-import-close.repository';
import type { PeopleImportConfirmService } from './people-import-confirm.service';
import { PeopleImportQueryService } from './people-import-query.service';
import type {
  PeopleImportWriteRepository,
  ReservedRow,
} from './people-import-write.repository';
import { PeopleImportWriterService } from './people-import-writer.service';
import type {
  BatchRecord,
  PeopleImportRepository,
} from './people-import.repository';
import type { RowWriter } from './row-writer';
import type { StructureCatalog } from './structure-match';

vi.mock('../team-whatsapp/team-actor.query', () => ({
  findTeamActor: vi.fn(),
}));

function teamActor(
  role: TeamActor['role'],
  change: Parameters<typeof actorWith>[1] = {},
  managedSectorIds: string[] = ['s1'],
): TeamActor {
  return { ...actorWith(role, change), managedSectorIds };
}

const ADMIN = teamActor('ADMIN', { id: 'u-admin' });
const MANAGER = teamActor('SUPERVISOR', { id: 'u-manager' });
const OTHER = teamActor('SUPERVISOR', { id: 'u-other' });
const NO_EDIT = teamActor('SUPERVISOR', {
  id: 'u-manager',
  revoke: ['pessoas.editar'],
});
const NO_SECTOR = teamActor('SUPERVISOR', { id: 'u-manager' }, []);
const START = new Date('2026-11-19T15:00:00Z');
const HEADERS = ['nome', 'telefone'];
const CATALOG: StructureCatalog = { sector: [], shift: [], level: [] };
const WRITTEN: RowOutcome = {
  outcome: 'CREATED',
  reason: null,
  personId: 'c-written',
};
const NOT_FOUND = { code: 'people_import.batch_not_found', status: 404 };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PREVIEW_COUNTS: Record<RowClass, number> = {
  CREATE: 3,
  UPDATE: 0,
  UNCHANGED: 0,
  INVALID: 0,
  DUPLICATE: 0,
  CONFLICT: 0,
  IGNORED: 0,
};
const COUNTS: ImportResultCounts = {
  rows: 3,
  created: 1,
  updated: 0,
  unchanged: 0,
  invalid: 0,
  duplicate: 0,
  conflict: 0,
  ignored: 0,
  failed: 0,
  phoneTaken: 0,
  notWritten: 0,
  writing: 0,
};

function batchOf(over: Partial<BatchRecord> = {}): BatchRecord {
  return {
    id: 'b1',
    fileName: 'pessoas.xlsx',
    fileSize: 2048,
    fileSha256: 'a'.repeat(64),
    format: 'xlsx',
    headers: HEADERS,
    mapping: suggestMapping(HEADERS),
    previewCounts: PREVIEW_COUNTS,
    createdById: 'u-manager',
    status: 'WRITING',
    createdAt: new Date('2026-11-19T12:00:00Z'),
    confirmedById: 'u-manager',
    confirmedAt: new Date('2026-11-19T14:59:00Z'),
    lastBlockAt: null,
    finishedAt: null,
    closedById: null,
    result: null,
    ...over,
  };
}

/** Linha de criação reservada: o `personId` é o da pessoa a criar (EX17.4 a). */
function rowOf(n: number): ReservedRow {
  const digits = String(n).padStart(4, '0');
  return {
    id: `r${n}`,
    rowNumber: n + 2,
    plan: {
      kind: 'create',
      keys: { registrationKey: null, phoneE164: `+559299111${digits}` },
      input: { name: `Pessoa Teste ${n}`, phone: `+559299111${digits}` },
    },
    personId: `c${digits.padStart(32, '0')}`,
  };
}

/** Consulta real (T17) sobre repositório falso; reservas saem de uma fila. */
function setup(input: { batch?: Partial<BatchRecord>; rows?: number } = {}) {
  const store = new Map([['b1', batchOf(input.batch)]]);
  const free = Array.from({ length: input.rows ?? 3 }, (_, n) => rowOf(n));
  const repo = {
    findBatch: vi.fn((id: string) => Promise.resolve(store.get(id) ?? null)),
    userNames: vi.fn(() => Promise.resolve(new Map<string, string | null>())),
    toWriteCount: vi.fn(() => Promise.resolve(0)),
    loadCatalog: vi.fn(() => Promise.resolve(CATALOG)),
  };
  const writeRepo = {
    touchBlock: vi.fn<PeopleImportWriteRepository['touchBlock']>(),
    reserveNextRow: vi.fn<PeopleImportWriteRepository['reserveNextRow']>(() =>
      Promise.resolve(free.shift() ?? null),
    ),
    finalizeRow: vi.fn<PeopleImportWriteRepository['finalizeRow']>(() =>
      Promise.resolve(true),
    ),
  };
  const closeRepo = {
    settleExpired: vi.fn(() => Promise.resolve(0)),
    resultCounts: vi.fn(() => Promise.resolve(COUNTS)),
  };
  const prisma = {
    peopleImportRow: { count: vi.fn(() => Promise.resolve(3)) },
  } as unknown as PrismaService;
  const query = new PeopleImportQueryService(
    prisma,
    repo as unknown as PeopleImportRepository,
    closeRepo as unknown as PeopleImportCloseRepository,
  );
  const rowWriter = {
    write: vi.fn<RowWriter['write']>(() => Promise.resolve(WRITTEN)),
  };
  const confirmService = {
    completeIfDone: vi.fn<PeopleImportConfirmService['completeIfDone']>(),
  };
  const service = new PeopleImportWriterService(
    prisma,
    query,
    writeRepo as unknown as PeopleImportWriteRepository,
    rowWriter as unknown as RowWriter,
  );
  Object.assign(service, { repo, confirmService });
  return { service, store, repo, writeRepo, rowWriter, confirmService };
}

/** O ator é relido a cada pedido (`loadImportActor`). */
function actingAs(actor: TeamActor): void {
  vi.mocked(findTeamActor).mockResolvedValue(actor);
}

/** Relógio falso: cada chamada avança o relógio da API em `ms`. */
function spends(ms: number) {
  return () => {
    vi.setSystemTime(Date.now() + ms);
    return Promise.resolve(WRITTEN);
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(START);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('PeopleImportWriterService.writeBlock: lote ainda em prévia (T20b M1)', () => {
  it('sem quem confirmou: 409 para quem enxerga o lote, 404 para quem não', async () => {
    const preview = { status: 'PREVIEW', confirmedById: null } as const;
    const fakes = setup({ batch: preview });
    actingAs(ADMIN);
    await expect(
      fakes.service.writeBlock('u-admin', 'b1'),
    ).rejects.toMatchObject({ code: 'people_import.not_writing', status: 409 });
    actingAs(MANAGER);
    await expect(
      fakes.service.writeBlock('u-manager', 'b1'),
    ).rejects.toMatchObject({ code: 'people_import.not_writing', status: 409 });
    // O 409 só vem depois do `visibleBatch`: o lote alheio continua 404.
    actingAs(OTHER);
    await expect(
      fakes.service.writeBlock('u-other', 'b1'),
    ).rejects.toMatchObject(NOT_FOUND);
    expect(fakes.writeRepo.touchBlock).not.toHaveBeenCalled();
    expect(fakes.writeRepo.reserveNextRow).not.toHaveBeenCalled();
  });
});

describe('PeopleImportWriterService.writeBlock: limites do bloco (E6, EX10)', () => {
  it('bloco grava até 50 linhas', async () => {
    const fakes = setup({ rows: 60 });
    actingAs(MANAGER);
    await fakes.service.writeBlock('u-manager', 'b1');
    expect(fakes.writeRepo.reserveNextRow).toHaveBeenCalledTimes(50);
    expect(fakes.rowWriter.write).toHaveBeenCalledTimes(50);
    expect(fakes.writeRepo.finalizeRow).toHaveBeenCalledTimes(50);
    await fakes.service.writeBlock('u-manager', 'b1');
    expect(fakes.rowWriter.write).toHaveBeenCalledTimes(60);
    expect(fakes.writeRepo.reserveNextRow).toHaveBeenCalledTimes(61);
  });

  it('bloco para em 10 segundos', async () => {
    const fakes = setup({ rows: 10 });
    fakes.rowWriter.write.mockImplementation(spends(3_000));
    actingAs(MANAGER);
    await fakes.service.writeBlock('u-manager', 'b1');
    // reservas em 0, 3, 6 e 9 s; aos 12 s o bloco não reserva mais
    expect(fakes.writeRepo.reserveNextRow).toHaveBeenCalledTimes(4);
    expect(fakes.writeRepo.finalizeRow).toHaveBeenCalledTimes(4);
  });

  it('T27: com linha livre o bloco grava ao menos uma, mesmo depois de 10 s de preparo', async () => {
    const fakes = setup({ rows: 5 });
    fakes.repo.loadCatalog.mockImplementation(() => {
      vi.setSystemTime(Date.now() + 11_000);
      return Promise.resolve(CATALOG);
    });
    actingAs(MANAGER);
    const summary = await fakes.service.writeBlock('u-manager', 'b1');
    expect(fakes.rowWriter.write).toHaveBeenCalledTimes(1);
    expect(fakes.writeRepo.finalizeRow).toHaveBeenCalledTimes(1);
    expect(summary.situation).toBe('WRITING');
  });
});

describe('PeopleImportWriterService.writeBlock: só quem confirmou, com as permissões de agora (E6, EX10)', () => {
  it('só quem confirmou: 403 inclusive para o ADMIN; lote alheio 404 para gestor', async () => {
    const fakes = setup();
    actingAs(ADMIN);
    await expect(
      fakes.service.writeBlock('u-admin', 'b1'),
    ).rejects.toMatchObject({
      code: 'people_import.not_confirmer',
      status: 403,
    });
    actingAs(OTHER);
    await expect(
      fakes.service.writeBlock('u-other', 'b1'),
    ).rejects.toMatchObject(NOT_FOUND);
    expect(fakes.writeRepo.touchBlock).not.toHaveBeenCalled();
    expect(fakes.writeRepo.reserveNextRow).not.toHaveBeenCalled();
    expect(fakes.rowWriter.write).not.toHaveBeenCalled();
  });

  it('ator sem pessoas.editar: 403 e nenhuma reserva', async () => {
    const fakes = setup({ rows: 60 });
    actingAs(MANAGER);
    await fakes.service.writeBlock('u-manager', 'b1');
    // o mesmo confirmador perde a chave entre um bloco e o seguinte
    actingAs(NO_EDIT);
    await expect(
      fakes.service.writeBlock('u-manager', 'b1'),
    ).rejects.toMatchObject({
      code: 'auth.permission_denied',
      status: 403,
      detail: PERMISSION_DENIED_TEXT['pessoas.editar'],
    });
    actingAs(NO_SECTOR);
    await expect(
      fakes.service.writeBlock('u-manager', 'b1'),
    ).rejects.toMatchObject({ code: 'people_import.no_managed_sector' });
    expect(fakes.writeRepo.touchBlock).toHaveBeenCalledTimes(1);
    expect(fakes.writeRepo.reserveNextRow).toHaveBeenCalledTimes(50);
  });

  it('lote fora de gravação: 409', async () => {
    const fakes = setup({ batch: { status: 'COMPLETED' } });
    actingAs(MANAGER);
    await expect(
      fakes.service.writeBlock('u-manager', 'b1'),
    ).rejects.toMatchObject({ code: 'people_import.not_writing', status: 409 });
    expect(fakes.writeRepo.touchBlock).not.toHaveBeenCalled();
    expect(fakes.writeRepo.reserveNextRow).not.toHaveBeenCalled();
  });
});

describe('PeopleImportWriterService.writeBlock: reservas por pedido (EX9)', () => {
  it('reserva perdida: resultado descartado sem erro', async () => {
    const fakes = setup({ rows: 3 });
    fakes.writeRepo.finalizeRow.mockResolvedValueOnce(false);
    actingAs(MANAGER);
    const summary = await fakes.service.writeBlock('u-manager', 'b1');
    expect(fakes.rowWriter.write).toHaveBeenCalledTimes(3);
    expect(fakes.writeRepo.finalizeRow).toHaveBeenCalledTimes(3);
    expect(summary.id).toBe('b1');
  });

  it('cada pedido reserva e grava com o seu token', async () => {
    const fakes = setup({ rows: 60 });
    actingAs(MANAGER);
    await fakes.service.writeBlock('u-manager', 'b1');
    await fakes.service.writeBlock('u-manager', 'b1');
    const reserved = fakes.writeRepo.reserveNextRow.mock.calls.map(
      ([call]) => call.token,
    );
    const finalized = fakes.writeRepo.finalizeRow.mock.calls.map(
      ([call]) => call.token,
    );
    expect(new Set(reserved.slice(0, 50))).toEqual(new Set([reserved[0]]));
    expect(new Set(reserved.slice(50))).toEqual(new Set([reserved[50]]));
    expect(reserved[0]).toMatch(UUID);
    expect(reserved[50]).not.toBe(reserved[0]);
    expect(finalized).toEqual(reserved.slice(0, 60));
  });
});

describe('PeopleImportWriterService.writeBlock: andamento e conclusão (EX10, EX11, EX13)', () => {
  it('atualiza lastBlockAt e chama completeIfDone no fim do bloco', async () => {
    const fakes = setup({ rows: 2 });
    fakes.confirmService.completeIfDone.mockImplementation((batch) => {
      Object.assign(fakes.store.get(batch.id) ?? {}, { status: 'COMPLETED' });
      return Promise.resolve();
    });
    actingAs(MANAGER);
    const summary = await fakes.service.writeBlock('u-manager', 'b1');
    const touch = fakes.writeRepo.touchBlock;
    const complete = fakes.confirmService.completeIfDone;
    expect(touch).toHaveBeenCalledWith('b1', START);
    expect(touch.mock.invocationCallOrder[0]).toBeLessThan(
      fakes.writeRepo.reserveNextRow.mock.invocationCallOrder[0],
    );
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete.mock.calls[0][0]).toMatchObject({ id: 'b1' });
    expect(complete.mock.invocationCallOrder[0]).toBeGreaterThan(
      fakes.writeRepo.finalizeRow.mock.invocationCallOrder[1],
    );
    expect(summary.situation).toBe('COMPLETED');
  });
});

describe('PeopleImportWriterService.writeBlock: o que cada linha recebe (EX17.4 a, EX19 a, EX21)', () => {
  it('carrega o catálogo uma vez por bloco e o passa a cada linha, com o personId da reserva', async () => {
    const fakes = setup({ rows: 3 });
    actingAs(MANAGER);
    await fakes.service.writeBlock('u-manager', 'b1');
    expect(fakes.repo.loadCatalog).toHaveBeenCalledTimes(1);
    const calls = fakes.rowWriter.write.mock.calls.map(([call]) => call);
    expect(calls).toHaveLength(3);
    calls.forEach((call, n) => {
      expect(call.catalog).toBe(CATALOG);
      expect(call.plan).toEqual(rowOf(n).plan);
      expect(call.personId).toBe(rowOf(n).personId);
      expect(call.reason).toBe(importReason('pessoas.xlsx'));
      expect(call.actor).toMatchObject({
        id: 'u-manager',
        canEditPeople: true,
      });
    });
    const results = fakes.writeRepo.finalizeRow.mock.calls.map(([call]) => [
      call.rowId,
      call.result,
    ]);
    expect(results).toEqual([
      ['r0', WRITTEN],
      ['r1', WRITTEN],
      ['r2', WRITTEN],
    ]);
  });
});
