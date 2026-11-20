import { Injectable } from '@nestjs/common';
import {
  IMPORT_BATCHES_PAGE_SIZE,
  IMPORT_ROWS_PAGE_SIZE,
  type BatchList,
  type BatchListItem,
  type BatchSituation,
  type BatchSummary,
  type ImportProgress,
  type PersonRef,
  type RowClass,
  type RowsPage,
} from '../../schemas/contracts/people-import.schema';
import { nameView } from '../../shared/authz/phone-visibility';
import { PrismaService } from '../../shared/prisma/prisma.service';
import {
  canSeeBatch,
  loadImportActor,
  phoneFullFor,
  type ImportActor,
} from './import-actor';
import type { ImportResultCounts } from './import-person';
import { mappingProblem } from './mapping';
import { PeopleImportCloseRepository } from './people-import-close.repository';
import {
  batchNotFound,
  mappingIncomplete,
  notInPreview,
} from './people-import.errors';
import {
  PeopleImportRepository,
  type BatchRecord,
} from './people-import.repository';
import { toRowView } from './row-view';

/** EX11: sem bloco há mais que isso (a tela espera 120 s por bloco), a gravação parou. */
const INTERRUPTED_AFTER_MS = 3 * 60_000;

/** EX11: "Gravação interrompida" é derivada, sem estado a desfazer. */
export function batchSituation(batch: BatchRecord, now: Date): BatchSituation {
  if (batch.status !== 'WRITING') return batch.status;
  const last = batch.lastBlockAt ?? batch.confirmedAt ?? batch.createdAt;
  return last.getTime() < now.getTime() - INTERRUPTED_AFTER_MS
    ? 'INTERRUPTED'
    : 'WRITING';
}

/**
 * Só a prévia tem problema de mapeamento. Linhas sem classificação (EX30,
 * `previewCounts` nulo) são julgadas pela regra de quem não é ADMIN: o ADMIN
 * que abre o lote de um gestor vê o aviso que barrou a classificação, e a
 * prévia não serve linha sem classificação.
 */
function problemOf(batch: BatchRecord, actor: ImportActor): string | null {
  if (batch.status !== 'PREVIEW') return null;
  return mappingProblem(batch.mapping, {
    headerCount: batch.headers.length,
    isAdmin: actor.isAdmin && batch.previewCounts !== null,
  });
}

/**
 * Andamento a partir das contagens (T13b) e do total escolhido na confirmação
 * (`toWrite`, fixo depois dela). `unchanged` de `resultCounts` soma também as
 * linhas "Sem alteração" da prévia, que não entram na gravação: saem aqui
 * para que "Gravando X de Y" não passe de Y. Reserva vencida conta como
 * pendente (outro pedido a retoma).
 */
function progressOf(input: {
  result: ImportResultCounts;
  toWrite: number;
  previewUnchanged: number;
}): ImportProgress {
  const { result, toWrite } = input;
  const unchanged = Math.max(0, result.unchanged - input.previewUnchanged);
  const resolved =
    result.created +
    result.updated +
    unchanged +
    result.failed +
    result.notWritten;
  return {
    toWrite,
    pending: Math.max(0, toWrite - resolved - result.writing),
    writing: result.writing,
    created: result.created,
    updated: result.updated,
    unchanged,
    failed: result.failed,
    phoneTaken: result.phoneTaken,
    notWritten: result.notWritten,
  };
}

function hasErrorReport(
  counts: Record<RowClass, number> | null,
  progress: ImportProgress | null,
): boolean {
  const preview =
    counts === null ? 0 : counts.INVALID + counts.DUPLICATE + counts.CONFLICT;
  const written = progress === null ? 0 : progress.failed + progress.notWritten;
  return preview + written > 0;
}

/** EX25: confirmar só quem enviou; continuar só quem confirmou; encerrar só ADMIN. */
function actionsOf(actor: ImportActor, batch: BatchRecord) {
  const preview = batch.status === 'PREVIEW';
  const writing = batch.status === 'WRITING';
  return {
    canConfirm:
      preview &&
      batch.createdById === actor.id &&
      problemOf(batch, actor) === null,
    canContinue: writing && batch.confirmedById === actor.id,
    canClose: writing && actor.isAdmin,
    canDiscard: preview,
  };
}

type Names = ReadonlyMap<string, string | null>;

/** GX8: nome do autor com `nameView`; quem não existe mais fica sem nome. */
function personRef(id: string, names: Names, full: boolean): PersonRef {
  return { id, name: nameView(names.get(id) ?? null, { full }) };
}

function isoOrNull(date: Date | null): string | null {
  return date === null ? null : date.toISOString();
}

type SummaryInput = {
  actor: ImportActor;
  batch: BatchRecord;
  now: Date;
  names: Names;
  progress: ImportProgress | null;
};

function listItemOf(input: SummaryInput): BatchListItem {
  const { batch, names, progress } = input;
  const full = phoneFullFor(input.actor);
  return {
    id: batch.id,
    fileName: batch.fileName,
    fileSize: batch.fileSize,
    format: batch.format,
    situation: batchSituation(batch, input.now),
    createdAt: batch.createdAt.toISOString(),
    createdBy: personRef(batch.createdById, names, full),
    confirmedAt: isoOrNull(batch.confirmedAt),
    confirmedBy:
      batch.confirmedById === null
        ? null
        : personRef(batch.confirmedById, names, full),
    finishedAt: isoOrNull(batch.finishedAt),
    counts: batch.previewCounts,
    progress,
    ...actionsOf(input.actor, batch),
    hasErrorReport: hasErrorReport(batch.previewCounts, progress),
  };
}

function summaryOf(input: SummaryInput): BatchSummary {
  const { actor, batch } = input;
  return {
    ...listItemOf(input),
    headers: batch.headers,
    mapping: batch.mapping,
    mappingProblem: problemOf(batch, actor),
    // Conselho S: sem a chave, a prévia avisa que a conferência é feita ao gravar.
    phoneCheckDeferred: !phoneFullFor(actor),
  };
}

function authorIds(batch: BatchRecord): string[] {
  return batch.confirmedById === null
    ? [batch.createdById]
    : [batch.createdById, batch.confirmedById];
}

/**
 * Leitura dos lotes de importação (spec E5 e E7). O ator é relido a cada
 * pedido; lote inexistente ou alheio responde o mesmo 404 (GX9).
 */
@Injectable()
export class PeopleImportQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: PeopleImportRepository,
    private readonly closeRepo: PeopleImportCloseRepository,
  ) {}

  async visibleBatch(
    actor: ImportActor,
    batchId: string,
  ): Promise<BatchRecord> {
    const batch = await this.repo.findBatch(batchId);
    if (batch === null || !canSeeBatch(actor, batch)) throw batchNotFound();
    return batch;
  }

  async summary(actorId: string, batchId: string): Promise<BatchSummary> {
    const actor = await loadImportActor(this.prisma, actorId);
    const batch = await this.visibleBatch(actor, batchId);
    return this.summaryFor(actor, batch);
  }

  async summaryFor(
    actor: ImportActor,
    batch: BatchRecord,
  ): Promise<BatchSummary> {
    const now = new Date();
    const [names, progress] = await Promise.all([
      this.repo.userNames(authorIds(batch)),
      this.progressFor(batch, now),
    ]);
    return summaryOf({ actor, batch, now, names, progress });
  }

  /** EX26: 404 → 409 fora de prévia → 422 com o texto do mapeamento incompleto. */
  async rows(
    actorId: string,
    batchId: string,
    query: { page: number; classification?: RowClass },
  ): Promise<RowsPage> {
    const actor = await loadImportActor(this.prisma, actorId);
    const batch = await this.visibleBatch(actor, batchId);
    if (batch.status !== 'PREVIEW') throw notInPreview();
    const problem = problemOf(batch, actor);
    if (problem !== null) throw mappingIncomplete(problem);
    const page = await this.repo.pageRows(batch.id, query);
    return {
      items: page.items.map((row) =>
        toRowView({ row, mapping: batch.mapping, actor }),
      ),
      total: page.total,
      page: query.page,
      pageSize: IMPORT_ROWS_PAGE_SIZE,
    };
  }

  /** GX9: o ADMIN lista todos os lotes; os demais, só os que enviaram. */
  async list(actorId: string, query: { page: number }): Promise<BatchList> {
    const actor = await loadImportActor(this.prisma, actorId);
    const page = await this.repo.listBatches({
      createdById: actor.isAdmin ? null : actor.id,
      page: query.page,
    });
    const now = new Date();
    const names = await this.repo.userNames(page.items.flatMap(authorIds));
    const items: BatchListItem[] = [];
    // Um lote por vez: cada contagem abre a sua transação (T13b).
    for (const batch of page.items) {
      const progress = await this.progressFor(batch, now);
      items.push(listItemOf({ actor, batch, now, names, progress }));
    }
    return {
      items,
      total: page.total,
      page: query.page,
      pageSize: IMPORT_BATCHES_PAGE_SIZE,
    };
  }

  /** Nulo em prévia; lote encerrado acerta as reservas vencidas antes (EX13). */
  private async progressFor(
    batch: BatchRecord,
    now: Date,
  ): Promise<ImportProgress | null> {
    if (batch.status === 'PREVIEW') return null;
    if (batch.status === 'CLOSED') {
      await this.closeRepo.settleExpired(batch.id, now);
    }
    const [result, toWrite] = await Promise.all([
      this.closeRepo.resultCounts(batch.id, now),
      this.repo.toWriteCount(batch.id),
    ]);
    return progressOf({
      result,
      toWrite,
      previewUnchanged: batch.previewCounts?.UNCHANGED ?? 0,
    });
  }
}
