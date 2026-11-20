import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RowClass } from '../../schemas/contracts/people-import.schema';
import { actorWith } from '../../shared/authz/actor.test-fixtures';
import type { PrismaService } from '../../shared/prisma/prisma.service';
import { findTeamActor } from '../team-whatsapp/team-actor.query';
import type { TeamActor } from '../team-whatsapp/team-whatsapp.policy';
import type { ImportResultCounts } from './import-person';
import { suggestMapping } from './mapping';
import type { PeopleImportCloseRepository } from './people-import-close.repository';
import {
  PeopleImportQueryService,
  batchSituation,
} from './people-import-query.service';
import type {
  BatchRecord,
  PeopleImportRepository,
  StoredRow,
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
const BLIND = teamActor('SUPERVISOR', {
  id: 'u-blind',
  revoke: ['telefone.ver_completo'],
});
const MAPPING = suggestMapping(['nome', 'matricula', 'telefone', 'setor']);
const COUNTS: Record<RowClass, number> = {
  CREATE: 3,
  UPDATE: 2,
  UNCHANGED: 1,
  INVALID: 1,
  DUPLICATE: 0,
  CONFLICT: 0,
  IGNORED: 1,
};
const NO_RESULT: ImportResultCounts = {
  rows: 8,
  created: 0,
  updated: 0,
  unchanged: 1,
  invalid: 1,
  duplicate: 0,
  conflict: 0,
  ignored: 1,
  failed: 0,
  phoneTaken: 0,
  notWritten: 0,
  writing: 0,
};
const NOT_FOUND = { code: 'people_import.batch_not_found', status: 404 };
const CREATED_AT = new Date('2026-11-19T12:00:00Z');

function batchOf(over: Partial<BatchRecord> = {}): BatchRecord {
  return {
    id: 'b1',
    fileName: 'pessoas.xlsx',
    fileSize: 2048,
    fileSha256: 'a'.repeat(64),
    format: 'xlsx',
    headers: ['nome', 'matricula', 'telefone', 'setor'],
    mapping: MAPPING,
    previewCounts: COUNTS,
    createdById: 'u-manager',
    status: 'PREVIEW',
    createdAt: CREATED_AT,
    confirmedById: null,
    confirmedAt: null,
    lastBlockAt: null,
    finishedAt: null,
    closedById: null,
    result: null,
    ...over,
  };
}

type Fakes = {
  batches?: BatchRecord[];
  result?: ImportResultCounts;
  toWrite?: number;
  names?: Record<string, string | null>;
};

function setup(fakes: Fakes = {}) {
  const batches = fakes.batches ?? [batchOf()];
  const repo = {
    findBatch: vi.fn((id: string) =>
      Promise.resolve(batches.find((batch) => batch.id === id) ?? null),
    ),
    pageRows: vi.fn(() =>
      Promise.resolve({ total: 0, items: [] as StoredRow[] }),
    ),
    listBatches: vi.fn(() =>
      Promise.resolve({ total: batches.length, items: batches }),
    ),
    toWriteCount: vi.fn(() => Promise.resolve(fakes.toWrite ?? 0)),
    userNames: vi.fn(() =>
      Promise.resolve(new Map(Object.entries(fakes.names ?? {}))),
    ),
  };
  const closeRepo = {
    settleExpired: vi.fn(() => Promise.resolve(0)),
    resultCounts: vi.fn(() => Promise.resolve(fakes.result ?? NO_RESULT)),
  };
  const service = new PeopleImportQueryService(
    {} as unknown as PrismaService,
    repo as unknown as PeopleImportRepository,
    closeRepo as unknown as PeopleImportCloseRepository,
  );
  return { service, repo, closeRepo };
}

/** O ator é relido a cada pedido (`loadImportActor`). */
function actingAs(actor: TeamActor): void {
  vi.mocked(findTeamActor).mockResolvedValue(actor);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('PeopleImportQueryService: quem vê o lote (GX9)', () => {
  it('lote de outra pessoa responde 404 para quem não é ADMIN; ADMIN vê', async () => {
    const { service, repo } = setup({
      batches: [batchOf({ createdById: 'u-other' })],
    });
    actingAs(MANAGER);
    await expect(service.summary('u-manager', 'b1')).rejects.toMatchObject(
      NOT_FOUND,
    );
    await expect(
      service.rows('u-manager', 'b1', { page: 1 }),
    ).rejects.toMatchObject(NOT_FOUND);
    await expect(
      service.summary('u-manager', 'nao-existe'),
    ).rejects.toMatchObject(NOT_FOUND);
    expect(repo.pageRows).not.toHaveBeenCalled();
    actingAs(ADMIN);
    await expect(service.summary('u-admin', 'b1')).resolves.toMatchObject({
      id: 'b1',
      createdBy: { id: 'u-other' },
    });
  });
});

describe('PeopleImportQueryService: registro do lote', () => {
  it('aceite 23: resumo traz arquivo, autor, envio, confirmação, fim e contagens', async () => {
    const batch = batchOf({
      status: 'COMPLETED',
      confirmedById: 'u-manager',
      confirmedAt: new Date('2026-11-19T12:05:00Z'),
      finishedAt: new Date('2026-11-19T12:09:00Z'),
    });
    const result = { ...NO_RESULT, created: 2, updated: 1, unchanged: 2 };
    const { service, repo } = setup({
      batches: [batch],
      result: { ...result, failed: 1, phoneTaken: 1 },
      toWrite: 5,
      names: { 'u-manager': 'Marina Costa' },
    });
    actingAs(MANAGER);
    const summary = await service.summary('u-manager', 'b1');
    expect(summary).toMatchObject({
      fileName: 'pessoas.xlsx',
      fileSize: 2048,
      format: 'xlsx',
      situation: 'COMPLETED',
      createdAt: '2026-11-19T12:00:00.000Z',
      createdBy: { id: 'u-manager', name: 'Marina Costa' },
      confirmedAt: '2026-11-19T12:05:00.000Z',
      confirmedBy: { id: 'u-manager', name: 'Marina Costa' },
      finishedAt: '2026-11-19T12:09:00.000Z',
      counts: COUNTS,
      hasErrorReport: true,
    });
    // `unchanged` do andamento: só as gravadas sem alteração (2 − 1 da prévia).
    expect(summary.progress).toEqual({
      toWrite: 5,
      pending: 0,
      writing: 0,
      created: 2,
      updated: 1,
      unchanged: 1,
      failed: 1,
      phoneTaken: 1,
      notWritten: 0,
    });
    expect(repo.toWriteCount).toHaveBeenCalledWith('b1');
  });
});

describe('PeopleImportQueryService: aviso de telefone (Conselho S)', () => {
  async function summaryOf(actor: TeamActor) {
    const { service } = setup({
      batches: [batchOf({ createdById: actor.id })],
      names: { [actor.id]: '(92) 99111-0002' },
    });
    actingAs(actor);
    return service.summary(actor.id, 'b1');
  }

  it('S1-6: phoneCheckDeferred só para quem não tem telefone.ver_completo', async () => {
    const blind = await summaryOf(BLIND);
    expect(blind.phoneCheckDeferred).toBe(true);
    expect(blind.createdBy.name).toBe('•••• 0002');
    expect((await summaryOf(MANAGER)).phoneCheckDeferred).toBe(false);
    expect((await summaryOf(ADMIN)).phoneCheckDeferred).toBe(false);
    const { service } = setup({
      batches: [batchOf({ createdById: 'u-blind' })],
    });
    actingAs(BLIND);
    const [item] = (await service.list('u-blind', { page: 1 })).items;
    expect(item).toMatchObject({ id: 'b1', createdBy: { id: 'u-blind' } });
    for (const field of ['phoneCheckDeferred', 'headers', 'mapping']) {
      expect(item).not.toHaveProperty(field);
    }
    expect(item).not.toHaveProperty('mappingProblem');
  });
});

describe('PeopleImportQueryService: situação e andamento', () => {
  const now = new Date('2026-11-19T15:00:00Z');
  const ago = (ms: number) => new Date(now.getTime() - ms);
  const writing = (over: Partial<BatchRecord>) =>
    batchSituation(
      batchOf({ status: 'WRITING', confirmedAt: ago(3_600_000), ...over }),
      now,
    );

  it('situação: Gravação interrompida depois de 3 minutos sem bloco', () => {
    expect(writing({ lastBlockAt: ago(3 * 60_000) })).toBe('WRITING');
    expect(writing({ lastBlockAt: ago(3 * 60_000 + 1) })).toBe('INTERRUPTED');
    expect(writing({ lastBlockAt: null, confirmedAt: ago(60_000) })).toBe(
      'WRITING',
    );
    expect(writing({ lastBlockAt: null })).toBe('INTERRUPTED');
    const closed = batchOf({ status: 'CLOSED', lastBlockAt: ago(3_600_000) });
    expect(batchSituation(closed, now)).toBe('CLOSED');
    expect(batchSituation(batchOf(), now)).toBe('PREVIEW');
  });

  it('andamento: pendentes = a gravar menos resolvidas e em gravação', async () => {
    const { service } = setup({
      batches: [batchOf({ status: 'WRITING', lastBlockAt: new Date() })],
      result: { ...NO_RESULT, created: 1, writing: 1 },
      toWrite: 5,
    });
    actingAs(MANAGER);
    const summary = await service.summary('u-manager', 'b1');
    expect(summary.situation).toBe('WRITING');
    expect(summary.progress).toMatchObject({
      toWrite: 5,
      pending: 3,
      writing: 1,
      unchanged: 0,
    });
  });
});

describe('PeopleImportQueryService: quem faz o quê (EX25)', () => {
  async function actions(actor: TeamActor, over: Partial<BatchRecord> = {}) {
    const { service } = setup({ batches: [batchOf(over)] });
    actingAs(actor);
    const s = await service.summary(actor.id, 'b1');
    return [s.canConfirm, s.canContinue, s.canClose, s.canDiscard];
  }
  const confirmed = {
    status: 'WRITING' as const,
    confirmedById: 'u-manager',
    confirmedAt: new Date(),
  };

  it('confirmar só quem enviou; continuar só quem confirmou; encerrar só ADMIN; descartar em prévia', async () => {
    expect(await actions(MANAGER)).toEqual([true, false, false, true]);
    expect(await actions(ADMIN)).toEqual([false, false, false, true]);
    const noName = { ...MAPPING, name: null };
    expect(await actions(MANAGER, { mapping: noName })).toEqual([
      false,
      false,
      false,
      true,
    ]);
    expect(await actions(MANAGER, confirmed)).toEqual([
      false,
      true,
      false,
      false,
    ]);
    expect(await actions(ADMIN, confirmed)).toEqual([
      false,
      false,
      true,
      false,
    ]);
  });
});

describe('PeopleImportQueryService: linhas da prévia (E5, EX26)', () => {
  const row: StoredRow = {
    rowNumber: 7,
    cells: { '0': 'Ana Souza', '1': 'M-7', '3': 'Logística' },
    classification: 'UPDATE',
    reasons: [],
    warnings: [],
    preview: { personName: 'Ana Souza', diff: [] },
  };

  it('linhas: 50 por página, filtro por classificação, só em prévia', async () => {
    const { service, repo } = setup({
      batches: [batchOf(), batchOf({ id: 'b2', status: 'WRITING' })],
    });
    repo.pageRows.mockResolvedValue({ total: 51, items: [row] });
    actingAs(MANAGER);
    const query = { page: 2, classification: 'UPDATE' as const };
    const page = await service.rows('u-manager', 'b1', query);
    expect(repo.pageRows).toHaveBeenCalledWith('b1', query);
    expect(page).toMatchObject({ total: 51, page: 2, pageSize: 50 });
    expect(page.items).toMatchObject([
      {
        rowNumber: 7,
        name: 'Ana Souza',
        registration: 'M-7',
        selectable: true,
      },
    ]);
    await expect(
      service.rows('u-manager', 'b2', { page: 1 }),
    ).rejects.toMatchObject({ code: 'people_import.not_preview', status: 409 });
    expect(repo.pageRows).toHaveBeenCalledTimes(1);
  });
});

describe('PeopleImportQueryService: prévia com mapeamento incompleto (EX30)', () => {
  const incomplete = (detail: string) => ({
    code: 'people_import.mapping_incomplete',
    status: 422,
    detail,
  });

  it('linhas de lote em prévia com mapeamento incompleto: 422 mapping_incomplete com o texto', async () => {
    const { service, repo } = setup({
      batches: [
        batchOf({ mapping: { ...MAPPING, name: null }, previewCounts: null }),
        batchOf({
          id: 'b2',
          mapping: { ...MAPPING, sector: null },
          previewCounts: null,
        }),
      ],
    });
    actingAs(MANAGER);
    await expect(
      service.rows('u-manager', 'b1', { page: 1 }),
    ).rejects.toMatchObject(
      incomplete(
        'Escolha a coluna de Nome e pelo menos uma entre Telefone e Matrícula.',
      ),
    );
    // O ADMIN que abre o lote do gestor vê o aviso que barrou a classificação.
    actingAs(ADMIN);
    const sectorText =
      'Escolha a coluna de Setor: quem não é administrador informa o setor em todas as linhas.';
    await expect(
      service.rows('u-admin', 'b2', { page: 1 }),
    ).rejects.toMatchObject(incomplete(sectorText));
    await expect(service.summary('u-admin', 'b2')).resolves.toMatchObject({
      mappingProblem: sectorText,
      counts: null,
      progress: null,
    });
    expect(repo.pageRows).not.toHaveBeenCalled();
  });
});

describe('PeopleImportQueryService: lista e lote encerrado', () => {
  it('lista: ADMIN todos; demais os seus', async () => {
    const { service, repo } = setup();
    actingAs(ADMIN);
    const list = await service.list('u-admin', { page: 3 });
    expect(repo.listBatches).toHaveBeenLastCalledWith({
      createdById: null,
      page: 3,
    });
    expect(list).toMatchObject({ total: 1, page: 3, pageSize: 20 });
    expect(list.items.map((item) => item.id)).toEqual(['b1']);
    actingAs(MANAGER);
    await service.list('u-manager', { page: 1 });
    expect(repo.listBatches).toHaveBeenLastCalledWith({
      createdById: 'u-manager',
      page: 1,
    });
  });

  it('lote encerrado acerta reservas vencidas antes de contar', async () => {
    const { service, closeRepo } = setup({
      batches: [
        batchOf({ status: 'CLOSED', confirmedById: 'u-manager' }),
        batchOf({ id: 'b2', status: 'COMPLETED', confirmedById: 'u-manager' }),
        batchOf({ id: 'b3' }),
      ],
    });
    actingAs(ADMIN);
    await service.summary('u-admin', 'b1');
    expect(closeRepo.settleExpired).toHaveBeenCalledWith(
      'b1',
      expect.any(Date),
    );
    const [settled] = closeRepo.settleExpired.mock.invocationCallOrder;
    const [counted] = closeRepo.resultCounts.mock.invocationCallOrder;
    expect(settled).toBeLessThan(counted);
    await service.summary('u-admin', 'b2');
    expect(closeRepo.settleExpired).toHaveBeenCalledTimes(1);
    expect((await service.summary('u-admin', 'b3')).progress).toBeNull();
    expect(closeRepo.resultCounts).toHaveBeenCalledTimes(2);
  });
});
