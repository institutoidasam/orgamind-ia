import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { BatchSummary } from '../../schemas/contracts/people-import.schema';
import { PrismaService } from '../../shared/prisma/prisma.service';
import {
  assertCanWrite,
  loadImportActor,
  type ImportActor,
} from './import-actor';
import { importReason } from './import-trail';
import { PeopleImportConfirmService } from './people-import-confirm.service';
import { PeopleImportQueryService } from './people-import-query.service';
import { PeopleImportWriteRepository } from './people-import-write.repository';
import { notConfirmer, notWriting } from './people-import.errors';
import {
  type BatchRecord,
  PeopleImportRepository,
} from './people-import.repository';
import { RowWriter } from './row-writer';
import type { StructureCatalog } from './structure-match';

/** Spec E6: um bloco grava no máximo 50 linhas… */
export const BLOCK_MAX_ROWS = 50;
/** …por no máximo 10 segundos (conferido antes de cada reserva, EX10). */
export const BLOCK_MAX_MS = 10_000;

/** O que o laço de um bloco precisa; `token` é um por pedido (EX9). */
type Block = {
  batch: BatchRecord;
  actor: ImportActor;
  catalog: StructureCatalog;
  token: string;
  startedAt: number;
};

/**
 * EX10, nesta ordem e antes de qualquer escrita: só quem confirmou (403,
 * inclusive ADMIN, que só pode encerrar), só lote em gravação (409) e as
 * permissões relidas neste pedido (`assertCanWrite`: sem `pessoas.editar` ou
 * sem setor → 403). O 404 do lote alheio vem antes, do `visibleBatch`.
 * Desvio do EX10 (T20b M1): lote sem quem confirmou (ainda em prévia) é 409
 * `not_writing` antes da conferência do confirmador; o `visibleBatch` já
 * barrou quem não pode ver o lote, então o 409 não revela nada.
 */
function assertWritable(actor: ImportActor, batch: BatchRecord): void {
  if (batch.confirmedById === null) throw notWriting();
  if (batch.confirmedById !== actor.id) throw notConfirmer();
  if (batch.status !== 'WRITING') throw notWriting();
  assertCanWrite(actor);
}

/**
 * O tempo só barra a partir da segunda linha: bloco com linha livre grava ao
 * menos uma, mesmo que a preparação tenha demorado (a tela nunca recebe
 * "Gravando" sem andamento, T27).
 */
function timeLeft(block: Block, reserved: number): boolean {
  return reserved === 0 || Date.now() - block.startedAt < BLOCK_MAX_MS;
}

/**
 * Gravação em blocos pedidos pela tela (spec E6; CX12, EX9, EX10): grava na
 * API, sem a fila do worker, com o usuário e as permissões de quem confirmou,
 * relidos a cada bloco (o `RowWriter` não confere `pessoas.editar` por linha).
 */
@Injectable()
export class PeopleImportWriterService {
  // Injetados por propriedade: o construtor já tem 4 dependências, o teto de
  // parâmetros. Resolvidos pelo Nest antes do primeiro pedido.
  @Inject(PeopleImportRepository)
  private readonly repo!: PeopleImportRepository;

  @Inject(PeopleImportConfirmService)
  private readonly confirmService!: PeopleImportConfirmService;

  constructor(
    private readonly prisma: PrismaService,
    private readonly query: PeopleImportQueryService,
    private readonly writeRepo: PeopleImportWriteRepository,
    private readonly rowWriter: RowWriter,
  ) {}

  async writeBlock(actorId: string, batchId: string): Promise<BatchSummary> {
    const actor = await loadImportActor(this.prisma, actorId);
    const batch = await this.query.visibleBatch(actor, batchId);
    assertWritable(actor, batch);
    const startedAt = Date.now();
    await this.writeRepo.touchBlock(batch.id, new Date(startedAt));
    const catalog = await this.repo.loadCatalog();
    const token = randomUUID();
    await this.writeRows({ batch, actor, catalog, token, startedAt });
    await this.confirmService.completeIfDone(batch);
    // O lote mudou desde a leitura (conclusão, encerramento): relê, visível.
    const fresh = await this.query.visibleBatch(actor, batch.id);
    return this.query.summaryFor(actor, fresh);
  }

  /**
   * Uma linha por vez enquanto houver linha livre, até 50 reservas e 10 s.
   * `finalizeRow` falso = a reserva venceu e passou para outro pedido: o
   * resultado é descartado sem erro e o bloco segue.
   */
  private async writeRows(block: Block): Promise<void> {
    const reason = importReason(block.batch.fileName);
    for (let reserved = 0; reserved < BLOCK_MAX_ROWS; reserved += 1) {
      if (!timeLeft(block, reserved)) return;
      const row = await this.writeRepo.reserveNextRow({
        batchId: block.batch.id,
        now: new Date(),
        token: block.token,
      });
      if (row === null) return;
      const result = await this.rowWriter.write({
        plan: row.plan,
        personId: row.personId,
        actor: block.actor,
        reason,
        catalog: block.catalog,
      });
      await this.writeRepo.finalizeRow({
        rowId: row.id,
        token: block.token,
        now: new Date(),
        result,
      });
    }
  }
}
