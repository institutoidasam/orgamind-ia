import type { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RowClass } from '../../schemas/contracts/people-import.schema';
import type { AuditService } from '../../shared/audit/audit.service';
import { actorWith } from '../../shared/authz/actor.test-fixtures';
import type { PrismaService } from '../../shared/prisma/prisma.service';
import { findTeamActor } from '../team-whatsapp/team-actor.query';
import type { TeamActor } from '../team-whatsapp/team-whatsapp.policy';
import type { ImportResultCounts } from './import-person';
import { suggestMapping } from './mapping';
import type { PeopleImportCloseRepository } from './people-import-close.repository';
import { PeopleImportConfirmService } from './people-import-confirm.service';
import { PeopleImportQueryService } from './people-import-query.service';
import type { PeopleImportWriteRepository } from './people-import-write.repository';
import type {
  BatchRecord,
  PeopleImportRepository,
} from './people-import.repository';

vi.mock('../team-whatsapp/team-actor.query', () => ({
  findTeamActor: vi.fn(),
}));

function teamActor(
  role: TeamActor['role'],
  change: Parameters<typeof actorWith>[1] = {},
): TeamActor {
  return { ...actorWith(role, change), managedSectorIds: ['s1'] };
}

const ADMIN = teamActor('ADMIN', { id: 'u-admin' });
const MANAGER = teamActor('SUPERVISOR', { id: 'u-manager' });
const NO_EDIT = teamActor('SUPERVISOR', {
  id: 'u-manager',
  revoke: ['pessoas.editar'],
});
const TX = {} as Prisma.TransactionClient;
const NOW = new Date('2026-11-19T15:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const HEADERS = ['nome', 'matricula', 'telefone', 'setor', 'observacao'];
const PREVIEW_COUNTS: Record<RowClass, number> = {
  CREATE: 3,
  UPDATE: 2,
  UNCHANGED: 1,
  INVALID: 1,
  DUPLICATE: 0,
  CONFLICT: 0,
  IGNORED: 1,
};
const COUNTS: ImportResultCounts = {
  rows: 8,
  created: 2,
  updated: 1,
  unchanged: 1,
  invalid: 1,
  duplicate: 0,
  conflict: 0,
  ignored: 1,
  failed: 1,
  phoneTaken: 1,
  notWritten: 1,
  writing: 0,
};
const ALREADY = { code: 'people_import.already_confirmed', status: 409 };
const NOT_FOUND = { code: 'people_import.batch_not_found', status: 404 };
const AUTO_REASON =
  'Encerrada automaticamente: gravação interrompida há mais de 7 dias.';

function batchOf(over: Partial<BatchRecord> = {}): BatchRecord {
  return {
    id: 'b1',
    fileName: 'pessoas.xlsx',
    fileSize: 2048,
    fileSha256: 'a'.repeat(64),
    format: 'xlsx',
    headers: HEADERS,
    mapping: suggestMapping(HEADERS.slice(0, 4)),
    previewCounts: PREVIEW_COUNTS,
    createdById: 'u-manager',
    status: 'PREVIEW',
    createdAt: new Date('2026-11-19T12:00:00Z'),
    confirmedById: null,
    confirmedAt: null,
    lastBlockAt: null,
    finishedAt: null,
    closedById: null,
    result: null,
    ...over,
  };
}

/** Consulta real (T17) sobre um repositório falso; os repositórios de gravação são falsos. */
function setup(batches: BatchRecord[] = [batchOf()]) {
  const store = new Map(batches.map((batch) => [batch.id, { ...batch }]));
  const repo = {
    findBatch: vi.fn((id: string) => Promise.resolve(store.get(id) ?? null)),
    userNames: vi.fn(() => Promise.resolve(new Map<string, string | null>())),
    toWriteCount: vi.fn(() => Promise.resolve(0)),
  };
  const writeRepo = {
    confirm: vi.fn<PeopleImportWriteRepository['confirm']>(),
  };
  const closeRepo = {
    close: vi.fn<PeopleImportCloseRepository['close']>(),
    completeIfDone: vi.fn<PeopleImportCloseRepository['completeIfDone']>(),
    staleWriting: vi.fn<PeopleImportCloseRepository['staleWriting']>(),
    settleExpired: vi.fn(() => Promise.resolve(0)),
    resultCounts: vi.fn(() => Promise.resolve(COUNTS)),
  };
  const prisma = {
    peopleImportRow: { count: vi.fn(() => Promise.resolve(5)) },
  } as unknown as PrismaService;
  const closeFake = closeRepo as unknown as PeopleImportCloseRepository;
  const query = new PeopleImportQueryService(
    prisma,
    repo as unknown as PeopleImportRepository,
    closeFake,
  );
  const audit = {
    recordChange: vi.fn<AuditService['recordChange']>(() => Promise.resolve()),
  };
  const service = new PeopleImportConfirmService(
    prisma,
    query,
    writeRepo as unknown as PeopleImportWriteRepository,
    closeFake,
  );
  Object.assign(service, { audit });
  return { service, store, writeRepo, closeRepo, audit };
}

type Fakes = ReturnType<typeof setup>;

/** O repositório (T13a) só vira o lote que ainda está em prévia e grava a trilha. */
function confirmFlips(fakes: Fakes, counts = { toCreate: 3, toUpdate: 0 }) {
  fakes.writeRepo.confirm.mockImplementation(async (input) => {
    const batch = fakes.store.get(input.batchId);
    if (batch === undefined || batch.status !== 'PREVIEW') return 'not_preview';
    Object.assign(batch, {
      status: 'WRITING',
      confirmedById: input.actorId,
      confirmedAt: input.now,
      lastBlockAt: input.now,
    });
    await input.trail(TX, counts);
    return counts;
  });
}

/** O repositório (T13b) encerra, grava a trilha com as contagens e devolve-as. */
function closeWrites(fakes: Fakes, counts: ImportResultCounts = COUNTS) {
  fakes.closeRepo.close.mockImplementation(async (input) => {
    const batch = fakes.store.get(input.batchId);
    if (batch !== undefined) {
      Object.assign(batch, { status: 'CLOSED', closedById: input.closedById });
    }
    await input.trail(TX, counts);
    return counts;
  });
}

/** O ator é relido a cada pedido (`loadImportActor`). */
function actingAs(actor: TeamActor): void {
  vi.mocked(findTeamActor).mockResolvedValue(actor);
}

function recorded(fakes: Fakes, call = 0) {
  const [tx, change] = fakes.audit.recordChange.mock.calls[call];
  expect(tx).toBe(TX);
  return change;
}

/** O corpo leva o mapeamento da prévia que a tela mostrou (I1). */
const BODY = {
  createNew: true,
  updateExisting: false,
  excludedRows: [3],
  mapping: batchOf().mapping,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('PeopleImportConfirmService.confirm: a tela mostrou outro mapeamento (EX7, EX8)', () => {
  // outra aba remapeou: Função passou a vir da coluna "observacao"
  const remapped = { ...BODY.mapping, jobTitle: 4 };

  it('mapeamento do corpo diferente do gravado: 409 preview_changed e nada muda', async () => {
    const fakes = setup([batchOf({ mapping: remapped })]);
    confirmFlips(fakes);
    actingAs(MANAGER);
    await expect(
      fakes.service.confirm('u-manager', 'b1', BODY),
    ).rejects.toMatchObject({
      code: 'people_import.preview_changed',
      status: 409,
    });
    expect(fakes.writeRepo.confirm).not.toHaveBeenCalled();
    expect(fakes.audit.recordChange).not.toHaveBeenCalled();
    expect(fakes.store.get('b1')?.status).toBe('PREVIEW');
  });

  it('a recusa vem depois do 404 e das regras do lote', async () => {
    const fakes = setup([
      batchOf({ mapping: remapped, createdById: 'u-other' }),
      batchOf({ id: 'b2', mapping: remapped, status: 'WRITING' }),
    ]);
    actingAs(MANAGER);
    await expect(
      fakes.service.confirm('u-manager', 'b1', BODY),
    ).rejects.toMatchObject(NOT_FOUND);
    await expect(
      fakes.service.confirm('u-manager', 'b2', BODY),
    ).rejects.toMatchObject(ALREADY);
  });
});

describe('PeopleImportConfirmService.confirm: a prévia mudou no meio (EX6, EX14)', () => {
  it('remapear entre a leitura e a confirmação: 409 preview_changed sem trilha', async () => {
    const fakes = setup();
    fakes.writeRepo.confirm.mockResolvedValue('preview_changed');
    actingAs(MANAGER);
    await expect(
      fakes.service.confirm('u-manager', 'b1', BODY),
    ).rejects.toMatchObject({
      code: 'people_import.preview_changed',
      status: 409,
    });
    // o repositório recebe o mapeamento validado, para conferir na transação
    expect(fakes.writeRepo.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ mapping: batchOf().mapping }),
    );
    expect(fakes.audit.recordChange).not.toHaveBeenCalled();
  });
});

describe('PeopleImportConfirmService.confirm: gravação da seleção (EX7, EX8, GX5)', () => {
  it('confirma: marca a seleção, limpa e grava people_import.confirmed', async () => {
    const fakes = setup();
    confirmFlips(fakes);
    actingAs(MANAGER);
    const summary = await fakes.service.confirm('u-manager', 'b1', BODY);
    expect(fakes.writeRepo.confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        batchId: 'b1',
        actorId: 'u-manager',
        createNew: true,
        updateExisting: false,
        excludedRows: [3],
        mapping: suggestMapping(HEADERS.slice(0, 4)),
      }),
    );
    expect(fakes.audit.recordChange).toHaveBeenCalledTimes(1);
    expect(recorded(fakes)).toEqual({
      action: 'people_import.confirmed',
      entity: 'Spreadsheet',
      entityId: 'b1',
      category: 'SPREADSHEET',
      subjectUserId: null,
      reason: null,
      actorId: 'u-manager',
      changes: [
        { field: 'fileName', before: null, after: 'pessoas.xlsx' },
        { field: 'rowCount', before: null, after: 8 },
        { field: 'toCreate', before: null, after: 3 },
        { field: 'toUpdate', before: null, after: 0 },
      ],
    });
    // o resumo é relido depois da confirmação
    expect(summary.situation).toBe('WRITING');
    expect(summary.confirmedBy?.id).toBe('u-manager');
  });

  it('aceite 21: segunda confirmação responde 409 already_confirmed e não grava trilha', async () => {
    const fakes = setup();
    fakes.writeRepo.confirm.mockResolvedValue('not_preview');
    actingAs(MANAGER);
    await expect(
      fakes.service.confirm('u-manager', 'b1', BODY),
    ).rejects.toMatchObject(ALREADY);
    expect(fakes.audit.recordChange).not.toHaveBeenCalled();
  });
});

describe('PeopleImportConfirmService.confirm: lote fora de prévia (EX8, M2)', () => {
  it('lote já em gravação ou concluído: 409 already_confirmed sem chamar o repositório', async () => {
    const fakes = setup([
      batchOf(),
      batchOf({ id: 'b2', status: 'COMPLETED' }),
    ]);
    confirmFlips(fakes);
    actingAs(MANAGER);
    await fakes.service.confirm('u-manager', 'b1', BODY);
    await expect(
      fakes.service.confirm('u-manager', 'b1', BODY),
    ).rejects.toMatchObject(ALREADY);
    await expect(
      fakes.service.confirm('u-manager', 'b2', BODY),
    ).rejects.toMatchObject(ALREADY);
    expect(fakes.writeRepo.confirm).toHaveBeenCalledTimes(1);
    expect(fakes.audit.recordChange).toHaveBeenCalledTimes(1);
  });
});

describe('PeopleImportConfirmService.confirm: quem confirma (EX25, GX6)', () => {
  it('só quem enviou confirma; ADMIN em lote alheio recebe 403', async () => {
    const fakes = setup();
    actingAs(ADMIN);
    await expect(
      fakes.service.confirm('u-admin', 'b1', BODY),
    ).rejects.toMatchObject({
      code: 'people_import.not_uploader',
      status: 403,
    });
    expect(fakes.writeRepo.confirm).not.toHaveBeenCalled();
  });

  it('quem não é ADMIN sem pessoas.editar: 403', async () => {
    // em gravação: a negação vem antes do 409 (ordem do EX8)
    const fakes = setup([batchOf({ status: 'WRITING' })]);
    actingAs(NO_EDIT);
    await expect(
      fakes.service.confirm('u-manager', 'b1', BODY),
    ).rejects.toMatchObject({ code: 'auth.permission_denied', status: 403 });
    expect(fakes.writeRepo.confirm).not.toHaveBeenCalled();
  });
});

describe('PeopleImportConfirmService: lote alheio ou inexistente (GX9)', () => {
  it('confirmar e encerrar respondem o mesmo 404', async () => {
    const fakes = setup([
      batchOf({ createdById: 'u-other', status: 'WRITING' }),
    ]);
    actingAs(MANAGER);
    for (const id of ['b1', 'b-missing']) {
      await expect(
        fakes.service.confirm('u-manager', id, BODY),
      ).rejects.toMatchObject(NOT_FOUND);
      await expect(fakes.service.close('u-manager', id)).rejects.toMatchObject(
        NOT_FOUND,
      );
    }
    expect(fakes.writeRepo.confirm).not.toHaveBeenCalled();
    expect(fakes.closeRepo.close).not.toHaveBeenCalled();
  });
});

describe('PeopleImportConfirmService.confirm: seleção e colunas (EX7, CX6)', () => {
  it('nada escolhido: 422', async () => {
    const fakes = setup();
    fakes.writeRepo.confirm.mockResolvedValue('nothing_selected');
    actingAs(MANAGER);
    await expect(
      fakes.service.confirm('u-manager', 'b1', BODY),
    ).rejects.toMatchObject({
      code: 'people_import.nothing_selected',
      status: 422,
    });
    expect(fakes.audit.recordChange).not.toHaveBeenCalled();
  });

  it('mapeamento incompleto: 422 sem chamar o repositório', async () => {
    const noSector = suggestMapping(['nome', 'matricula', 'telefone']);
    const fakes = setup([batchOf({ mapping: noSector })]);
    actingAs(MANAGER);
    await expect(
      fakes.service.confirm('u-manager', 'b1', BODY),
    ).rejects.toMatchObject({
      code: 'people_import.mapping_incomplete',
      status: 422,
    });
    expect(fakes.writeRepo.confirm).not.toHaveBeenCalled();
  });
});

describe('PeopleImportConfirmService.close: encerrar (EX13, EX25)', () => {
  it('encerrar: só ADMIN; pendentes viram Não gravada; trilha com quem encerrou', async () => {
    const writing = batchOf({ status: 'WRITING', confirmedById: 'u-manager' });
    const fakes = setup([writing]);
    closeWrites(fakes, { ...COUNTS, notWritten: 2, writing: 1 });
    actingAs(MANAGER);
    await expect(fakes.service.close('u-manager', 'b1')).rejects.toMatchObject({
      code: 'people_import.close_admin_only',
      status: 403,
    });
    expect(fakes.closeRepo.close).not.toHaveBeenCalled();
    actingAs(ADMIN);
    const summary = await fakes.service.close('u-admin', 'b1');
    expect(fakes.closeRepo.close).toHaveBeenCalledWith(
      expect.objectContaining({ batchId: 'b1', closedById: 'u-admin' }),
    );
    expect(fakes.audit.recordChange).toHaveBeenCalledTimes(1);
    const change = recorded(fakes);
    expect(change).toMatchObject({
      action: 'people_import.completed',
      category: 'SPREADSHEET',
      actorId: 'u-admin',
      subjectUserId: null,
      reason: null,
    });
    expect(change.changes).toEqual(
      expect.arrayContaining([
        { field: 'ending', before: null, after: 'CLOSED' },
        { field: 'notWritten', before: null, after: 2 },
        { field: 'writing', before: null, after: 1 },
      ]),
    );
    expect(summary.situation).toBe('CLOSED');
  });
});

describe('PeopleImportConfirmService.close: só lote em gravação (EX13)', () => {
  it('lote fora de gravação: 409 not_writing', async () => {
    const fakes = setup([batchOf(), batchOf({ id: 'b2', status: 'WRITING' })]);
    fakes.closeRepo.close.mockResolvedValue(null);
    actingAs(ADMIN);
    const notWriting = { code: 'people_import.not_writing', status: 409 };
    await expect(fakes.service.close('u-admin', 'b1')).rejects.toMatchObject(
      notWriting,
    );
    // b2 lido em gravação, encerrado por outro pedido antes da transação
    await expect(fakes.service.close('u-admin', 'b2')).rejects.toMatchObject(
      notWriting,
    );
    expect(fakes.closeRepo.close).toHaveBeenCalledTimes(1);
    expect(fakes.audit.recordChange).not.toHaveBeenCalled();
  });
});

describe('PeopleImportConfirmService.completeIfDone: conclusão (EX13)', () => {
  it('completeIfDone grava people_import.completed com o confirmador como autor', async () => {
    const fakes = setup();
    fakes.closeRepo.completeIfDone.mockImplementation(async (input) => {
      await input.trail(TX, COUNTS);
      return true;
    });
    const batch = batchOf({ status: 'WRITING', confirmedById: 'u-manager' });
    await fakes.service.completeIfDone(batch);
    expect(fakes.closeRepo.completeIfDone).toHaveBeenCalledWith(
      expect.objectContaining({ batchId: 'b1' }),
    );
    expect(fakes.audit.recordChange).toHaveBeenCalledTimes(1);
    const change = recorded(fakes);
    expect(change).toMatchObject({ actorId: 'u-manager', reason: null });
    expect(change.changes).toContainEqual({
      field: 'ending',
      before: null,
      after: 'COMPLETED',
    });
  });
});

describe('PeopleImportConfirmService.closeStale: encerramento automático (EX13)', () => {
  it('closeStale encerra gravações paradas há mais de 7 dias com o motivo automático', async () => {
    const fakes = setup();
    fakes.closeRepo.staleWriting.mockResolvedValue([
      { id: 'b1', confirmedById: 'u-manager', fileName: 'pessoas.xlsx' },
      { id: 'b2', confirmedById: 'u-other', fileName: 'outra.csv' },
    ]);
    // b2 já foi encerrado por outro pedido entre a busca e a transação
    fakes.closeRepo.close.mockImplementationOnce(async (input) => {
      await input.trail(TX, COUNTS);
      return COUNTS;
    });
    fakes.closeRepo.close.mockResolvedValueOnce(null);
    await expect(fakes.service.closeStale(NOW)).resolves.toBe(1);
    expect(fakes.closeRepo.staleWriting).toHaveBeenCalledWith(
      new Date(NOW.getTime() - 7 * DAY_MS),
    );
    expect(fakes.closeRepo.close).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        batchId: 'b2',
        closedById: 'u-other',
        now: NOW,
      }),
    );
    expect(fakes.audit.recordChange).toHaveBeenCalledTimes(1);
    const change = recorded(fakes);
    expect(change).toMatchObject({ actorId: 'u-manager', reason: AUTO_REASON });
    expect(change.changes).toContainEqual({
      field: 'ending',
      before: null,
      after: 'AUTO_CLOSED',
    });
  });
});
