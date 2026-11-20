import { Inject, Injectable } from '@nestjs/common';
import type {
  BatchSummary,
  ConfirmBody,
} from '../../schemas/contracts/people-import.schema';
import { AuditService } from '../../shared/audit/audit.service';
import { PrismaService } from '../../shared/prisma/prisma.service';
import {
  assertCanWrite,
  loadImportActor,
  type ImportActor,
} from './import-actor';
import type {
  ImportEnding,
  ImportResultCounts,
  TrailWriter,
} from './import-person';
import { importCompletedChange, importConfirmedChange } from './import-trail';
import { mappingProblem, sameMapping } from './mapping';
import { PeopleImportCloseRepository } from './people-import-close.repository';
import { PeopleImportQueryService } from './people-import-query.service';
import { PeopleImportWriteRepository } from './people-import-write.repository';
import {
  alreadyConfirmed,
  closeAdminOnly,
  mappingIncomplete,
  notUploader,
  notWriting,
  nothingSelected,
  previewChanged,
} from './people-import.errors';
import type { BatchRecord } from './people-import.repository';

/** EX13 automático: gravação parada há mais que isso é encerrada no próximo envio. */
const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/** Linhas do arquivo pela prévia: todas as classes, inclusive as Ignoradas. */
function rowCountOf(batch: BatchRecord): number {
  const counts = batch.previewCounts;
  if (counts === null) return 0;
  return Object.values(counts).reduce((sum, n) => sum + n, 0);
}

/**
 * EX8/EX25, nesta ordem e antes de qualquer escrita: quem enviou (403, inclusive
 * ADMIN), `assertCanWrite` com as permissões de agora (403), fora de prévia →
 * o mesmo 409 da segunda confirmação (M2: `not_preview` nunca sai daqui) e o
 * mapeamento (422). A regra do mapeamento é a do resumo (T17): linhas sem
 * classificação (EX30) são julgadas como de quem não é ADMIN.
 */
function assertConfirmable(actor: ImportActor, batch: BatchRecord): void {
  if (batch.createdById !== actor.id) throw notUploader();
  assertCanWrite(actor);
  if (batch.status !== 'PREVIEW') throw alreadyConfirmed();
  const problem = mappingProblem(batch.mapping, {
    headerCount: batch.headers.length,
    isAdmin: actor.isAdmin && batch.previewCounts !== null,
  });
  if (problem !== null) throw mappingIncomplete(problem);
}

/**
 * Confirmar, encerrar e concluir um lote de importação (spec E5, E6; CX12).
 * O ator é relido a cada pedido; lote inexistente ou alheio responde o mesmo
 * 404 (GX9, pelo `visibleBatch`). A trilha (GX5) vai na transação do
 * repositório, com autor explícito e só números (sem nome nem telefone).
 */
@Injectable()
export class PeopleImportConfirmService {
  // Injetado por propriedade: o construtor já tem 4 dependências, o teto de
  // parâmetros. Resolvido pelo Nest antes do primeiro pedido.
  @Inject(AuditService)
  private readonly audit!: AuditService;

  constructor(
    private readonly prisma: PrismaService,
    private readonly query: PeopleImportQueryService,
    private readonly writeRepo: PeopleImportWriteRepository,
    private readonly closeRepo: PeopleImportCloseRepository,
  ) {}

  /**
   * EX7/EX8: grava a seleção uma vez só; dois cliques → o segundo recebe 409.
   * Mapeamento do corpo (o da prévia que a tela mostrou) diferente do gravado,
   * ou remapear (EX6) entre a leitura e a confirmação → 409 `preview_changed`,
   * antes de qualquer escrita.
   */
  async confirm(
    actorId: string,
    batchId: string,
    body: ConfirmBody,
  ): Promise<BatchSummary> {
    const actor = await loadImportActor(this.prisma, actorId);
    const batch = await this.query.visibleBatch(actor, batchId);
    assertConfirmable(actor, batch);
    if (!sameMapping(batch.mapping, body.mapping)) throw previewChanged();
    const result = await this.writeRepo.confirm({
      batchId: batch.id,
      actorId: actor.id,
      now: new Date(),
      createNew: body.createNew,
      updateExisting: body.updateExisting,
      excludedRows: body.excludedRows,
      // o mapeamento validado acima (= o da tela); o repositório o reconfere
      // na transação
      mapping: batch.mapping,
      trail: (tx, counts) =>
        this.audit.recordChange(
          tx,
          importConfirmedChange({
            actorId: actor.id,
            batchId: batch.id,
            fileName: batch.fileName,
            rowCount: rowCountOf(batch),
            toCreate: counts.toCreate,
            toUpdate: counts.toUpdate,
          }),
        ),
    });
    if (result === 'not_preview') throw alreadyConfirmed();
    if (result === 'nothing_selected') throw nothingSelected();
    if (result === 'preview_changed') throw previewChanged();
    return this.freshSummary(actor, batch.id);
  }

  /** EX13/EX25: só ADMIN, só lote em gravação; autor da trilha = quem encerrou. */
  async close(actorId: string, batchId: string): Promise<BatchSummary> {
    const actor = await loadImportActor(this.prisma, actorId);
    const batch = await this.query.visibleBatch(actor, batchId);
    if (!actor.isAdmin) throw closeAdminOnly();
    if (batch.status !== 'WRITING') throw notWriting();
    const counts = await this.closeRepo.close({
      batchId: batch.id,
      closedById: actor.id,
      now: new Date(),
      trail: this.completedTrail(batch, actor.id, 'CLOSED'),
    });
    if (counts === null) throw notWriting();
    return this.freshSummary(actor, batch.id);
  }

  /**
   * EX13: conclui quando não sobra linha a gravar; a transição condicional do
   * repositório garante uma só conclusão e uma só trilha (autor = quem confirmou).
   */
  async completeIfDone(batch: BatchRecord): Promise<void> {
    const confirmerId = batch.confirmedById;
    if (confirmerId === null) return;
    await this.closeRepo.completeIfDone({
      batchId: batch.id,
      now: new Date(),
      trail: this.completedTrail(batch, confirmerId, 'COMPLETED'),
    });
  }

  /**
   * EX13 automático, no envio de um arquivo novo: gravação sem bloco há mais de
   * 7 dias é encerrada como no encerramento manual, com quem confirmou como
   * autor (e `closedById`). Lote que outro pedido já encerrou não conta.
   */
  async closeStale(now: Date): Promise<number> {
    const cutoff = new Date(now.getTime() - STALE_AFTER_MS);
    const stale = await this.closeRepo.staleWriting(cutoff);
    let closed = 0;
    // Um lote por vez: cada encerramento abre a sua transação (T13b).
    for (const batch of stale) {
      const counts = await this.closeRepo.close({
        batchId: batch.id,
        closedById: batch.confirmedById,
        now,
        trail: this.completedTrail(batch, batch.confirmedById, 'AUTO_CLOSED'),
      });
      if (counts !== null) closed += 1;
    }
    return closed;
  }

  private completedTrail(
    batch: { id: string; fileName: string },
    actorId: string,
    ending: ImportEnding,
  ): TrailWriter<ImportResultCounts> {
    return (tx, counts) =>
      this.audit.recordChange(
        tx,
        importCompletedChange({
          actorId,
          batchId: batch.id,
          fileName: batch.fileName,
          ending,
          counts,
        }),
      );
  }

  /** O resumo relê o lote: o que foi lido antes da transação já mudou. */
  private async freshSummary(
    actor: ImportActor,
    batchId: string,
  ): Promise<BatchSummary> {
    const batch = await this.query.visibleBatch(actor, batchId);
    return this.query.summaryFor(actor, batch);
  }
}
