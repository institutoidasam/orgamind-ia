import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Prisma, type PeopleImportRowClass } from '@prisma/client';
import { type ColumnMapping } from '../../schemas/contracts/people-import.schema';
import { PrismaService } from '../../shared/prisma/prisma.service';
import type { RowOutcome, RowPlan, TrailWriter } from './import-person';
import { sameMapping, unmappedColumns } from './mapping';

/** Linha reservada para gravar. `personId`: na criação, o id que a pessoa vai
 * ter (nunca nulo depois da reserva, EX9, EX17.4 a); na atualização, o da prévia. */
export type ReservedRow = {
  id: string;
  rowNumber: number;
  plan: RowPlan;
  personId: string | null;
};

type ConfirmCounts = { toCreate: number; toUpdate: number };

type ConfirmResult =
  ConfirmCounts | 'not_preview' | 'nothing_selected' | 'preview_changed';

/** Validade da reserva de uma linha (EX9, T13a): 5 minutos. */
const RESERVATION_MS = 5 * 60 * 1000;
const MAX_OUTCOME_REASON = 200;
// Linhas com erro guardam as colunas mapeadas e os motivos (EX14); as demais
// classificações, sem `writeState`, perdem o conteúdo na confirmação.
const ERROR_CLASSES: PeopleImportRowClass[] = [
  'INVALID',
  'DUPLICATE',
  'CONFLICT',
];
const CLEANED_CLASSES: PeopleImportRowClass[] = [
  'CREATE',
  'UPDATE',
  'UNCHANGED',
  'IGNORED',
];

/** Id da pessoa a criar: `c` + UUID sem hífens (33 caracteres, passa em `cuid()`). */
export function newPersonId(): string {
  return `c${randomUUID().replaceAll('-', '')}`;
}

/** Lançadas dentro da transação da confirmação para desfazer o `WRITING`. */
class NothingSelectedSignal extends Error {}
class PreviewChangedSignal extends Error {}

/** Corta por pontos de código: `VARCHAR(200)` conta caracteres e o corte não
 * parte um par substituto (emoji). */
function cutReason(reason: string | null | undefined): string | null {
  if (reason === null || reason === undefined) return null;
  return Array.from(reason).slice(0, MAX_OUTCOME_REASON).join('');
}

/** `timestamp(3)` guarda o relógio em UTC: o texto ISO evita o fuso da sessão. */
function utcTimestamp(date: Date): Prisma.Sql {
  return Prisma.sql`${date.toISOString()}::text::timestamp`;
}

@Injectable()
export class PeopleImportWriteRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Confirma o lote uma vez só (EX8): o `updateMany` condicional é quem decide;
   * dois pedidos juntos, o segundo espera o primeiro e não acha mais o lote em
   * `PREVIEW`. Seleção (EX7) e limpeza (EX14) e a trilha vão na mesma
   * transação; sem nenhuma linha escolhida, ou com o lote remapeado depois
   * que o serviço validou `mapping` (EX6), o `WRITING` é desfeito.
   */
  async confirm(input: {
    batchId: string;
    actorId: string;
    now: Date;
    createNew: boolean;
    updateExisting: boolean;
    excludedRows: readonly number[];
    mapping: ColumnMapping;
    trail: TrailWriter<ConfirmCounts>;
  }): Promise<ConfirmResult> {
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          const flipped = await tx.peopleImportBatch.updateMany({
            where: {
              id: input.batchId,
              status: 'PREVIEW',
              createdById: input.actorId,
            },
            data: {
              status: 'WRITING',
              confirmedById: input.actorId,
              confirmedAt: input.now,
              lastBlockAt: input.now,
            },
          });
          if (flipped.count === 0) return 'not_preview';
          const unmapped = await unmappedIfUnchanged(tx, input);
          const counts = await selectRows(tx, input);
          if (counts.toCreate + counts.toUpdate === 0) {
            throw new NothingSelectedSignal();
          }
          await cleanOnConfirm(tx, { ...input, unmappedColumns: unmapped });
          await input.trail(tx, counts);
          return counts;
        },
        { timeout: 30_000 },
      );
    } catch (error) {
      if (error instanceof NothingSelectedSignal) return 'nothing_selected';
      if (error instanceof PreviewChangedSignal) return 'preview_changed';
      throw error;
    }
  }

  /** Só lote em `WRITING` tem andamento a registrar. */
  async touchBlock(batchId: string, now: Date): Promise<void> {
    await this.prisma.peopleImportBatch.updateMany({
      where: { id: batchId, status: 'WRITING' },
      data: { lastBlockAt: now },
    });
  }

  /**
   * Reserva a próxima linha (EX9): um único UPDATE, com `FOR UPDATE SKIP
   * LOCKED`, só em lote `WRITING`. Reserva vencida volta a valer. A linha de
   * criação recebe o id da pessoa na primeira reserva e o mantém (COALESCE).
   * O lote é lido com `FOR SHARE`: se um `close` ainda não confirmou, a reserva
   * espera o commit e revalida o status (duas reservas não se bloqueiam).
   *
   * Ordem das travas (T13b m2): lote (`FOR SHARE`) antes da linha (`FOR UPDATE`),
   * a mesma do `close`, que muda o lote e depois as linhas. O `EXISTS` não é
   * correlacionado, então o Postgres não o vira semi-join e o avalia antes da
   * subconsulta das linhas (One-Time Filter). Se o plano mudar e a ordem
   * inverter, o pior caso é um deadlock (40P01) que aborta uma das duas
   * transações, nunca um dado errado.
   */
  async reserveNextRow(input: {
    batchId: string;
    now: Date;
    token: string;
  }): Promise<ReservedRow | null> {
    const until = new Date(input.now.getTime() + RESERVATION_MS);
    const rows = await this.prisma.$queryRaw<ReservedRow[]>`
      UPDATE "PeopleImportRow" r
         SET "writeState" = 'RESERVED', "reservedUntil" = ${utcTimestamp(until)},
             "reservationToken" = ${input.token},
             "personId" = CASE WHEN r."plan"->>'kind' = 'create'
                               THEN COALESCE(r."personId", ${newPersonId()})
                               ELSE r."personId" END
       WHERE r."id" = (
               SELECT "id" FROM "PeopleImportRow"
                WHERE "batchId" = ${input.batchId}
                  AND ("writeState" = 'PENDING'
                       OR ("writeState" = 'RESERVED'
                           AND "reservedUntil" < ${utcTimestamp(input.now)}))
                ORDER BY "rowNumber" LIMIT 1
                FOR UPDATE SKIP LOCKED)
         AND EXISTS (SELECT 1 FROM "PeopleImportBatch" b
                      WHERE b."id" = ${input.batchId} AND b."status" = 'WRITING'
                      FOR SHARE)
      RETURNING r."id", r."rowNumber", r."plan", r."personId"`;
    return rows[0] ?? null;
  }

  /**
   * Grava o resultado só para quem tem a reserva (token e `RESERVED`); `false`
   * = a reserva passou para outro pedido, o resultado é descartado sem erro.
   * Linha gravada fica só com número, resultado e pessoa; falha guarda as
   * colunas mapeadas e o motivo (EX14).
   */
  async finalizeRow(input: {
    rowId: string;
    token: string;
    now: Date;
    result: RowOutcome;
  }): Promise<boolean> {
    const { result } = input;
    const written = await this.prisma.peopleImportRow.updateMany({
      where: {
        id: input.rowId,
        reservationToken: input.token,
        writeState: 'RESERVED',
      },
      data: {
        writeState: 'DONE',
        outcome: result.outcome,
        outcomeReason: cutReason(result.reason),
        writtenAt: input.now,
        plan: Prisma.DbNull,
        ...(result.outcome === 'FAILED' ? {} : { cells: Prisma.DbNull }),
        ...(result.personId === null ? {} : { personId: result.personId }),
      },
    });
    return written.count === 1;
  }
}

/**
 * Relê o lote depois do flip: o `updateMany` já trava a linha até o commit, e
 * um remapear (EX6) que confirmou antes dele trocou mapeamento e linhas. Se o
 * mapeamento não é mais o validado, desfaz; senão, devolve as colunas não
 * mapeadas (EX14) calculadas com o que está gravado.
 */
async function unmappedIfUnchanged(
  tx: Prisma.TransactionClient,
  input: { batchId: string; mapping: ColumnMapping },
): Promise<number[]> {
  const batch = await tx.peopleImportBatch.findUniqueOrThrow({
    where: { id: input.batchId },
    select: { mapping: true, headers: true },
  });
  const stored = (batch.mapping ?? {}) as Partial<Record<string, unknown>>;
  if (!sameMapping(stored, input.mapping)) throw new PreviewChangedSignal();
  const headers = Array.isArray(batch.headers) ? batch.headers : [];
  return unmappedColumns(input.mapping, headers.length);
}

/** EX7: marca `PENDING` nas linhas escolhidas e devolve as contagens. */
async function selectRows(
  tx: Prisma.TransactionClient,
  input: {
    batchId: string;
    createNew: boolean;
    updateExisting: boolean;
    excludedRows: readonly number[];
  },
): Promise<ConfirmCounts> {
  const mark = async (
    classification: PeopleImportRowClass,
    chosen: boolean,
  ): Promise<number> => {
    if (!chosen) return 0;
    const { count } = await tx.peopleImportRow.updateMany({
      where: {
        batchId: input.batchId,
        classification,
        rowNumber: { notIn: [...input.excludedRows] },
      },
      data: { writeState: 'PENDING' },
    });
    return count;
  };
  return {
    toCreate: await mark('CREATE', input.createNew),
    toUpdate: await mark('UPDATE', input.updateExisting),
  };
}

/**
 * EX14, ao confirmar: tira as colunas não mapeadas de todas as linhas, a
 * prévia de todas, e o conteúdo e o plano das que não vão ser gravadas
 * (desmarcadas, Sem alteração, Ignoradas); as de erro perdem só o plano.
 */
async function cleanOnConfirm(
  tx: Prisma.TransactionClient,
  input: { batchId: string; unmappedColumns: readonly number[] },
): Promise<void> {
  const { batchId } = input;
  const unmapped = input.unmappedColumns.map(String);
  await tx.$executeRaw`
    UPDATE "PeopleImportRow" SET "cells" = "cells" - ${unmapped}::text[]
     WHERE "batchId" = ${batchId} AND "cells" IS NOT NULL`;
  await tx.peopleImportRow.updateMany({
    where: { batchId, writeState: 'PENDING' },
    data: { preview: Prisma.DbNull },
  });
  await tx.peopleImportRow.updateMany({
    where: { batchId, classification: { in: ERROR_CLASSES } },
    data: { preview: Prisma.DbNull, plan: Prisma.DbNull },
  });
  await tx.peopleImportRow.updateMany({
    where: {
      batchId,
      writeState: null,
      OR: [
        { classification: null },
        { classification: { in: CLEANED_CLASSES } },
      ],
    },
    data: { preview: Prisma.DbNull, cells: Prisma.DbNull, plan: Prisma.DbNull },
  });
}
