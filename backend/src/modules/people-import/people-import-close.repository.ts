import { Injectable } from '@nestjs/common';
import {
  Prisma,
  type PeopleImportOutcome,
  type PeopleImportRowClass,
  type PeopleImportWriteState,
} from '@prisma/client';
import { PrismaService } from '../../shared/prisma/prisma.service';
import type { ImportResultCounts, TrailWriter } from './import-person';
import { ROW_TEXT } from './row-texts';

type Client = Prisma.TransactionClient;
type CountField = Exclude<
  keyof ImportResultCounts,
  'rows' | 'phoneTaken' | 'writing'
>;

const TX_OPTIONS = { timeout: 30_000 };
const SNAPSHOT = Prisma.TransactionIsolationLevel.RepeatableRead;

const CLASS_FIELD: Partial<Record<PeopleImportRowClass, CountField>> = {
  UNCHANGED: 'unchanged',
  INVALID: 'invalid',
  DUPLICATE: 'duplicate',
  CONFLICT: 'conflict',
  IGNORED: 'ignored',
};

const OUTCOME_FIELD: Record<PeopleImportOutcome, CountField> = {
  CREATED: 'created',
  UPDATED: 'updated',
  UNCHANGED: 'unchanged',
  FAILED: 'failed',
  NOT_WRITTEN: 'notWritten',
};

/** Campo que a linha soma: o resultado da gravação, ou, sem ele, a classificação. */
function countField(
  classification: PeopleImportRowClass | null,
  outcome: PeopleImportOutcome | null,
): CountField | undefined {
  if (outcome !== null) return OUTCOME_FIELD[outcome];
  return classification === null ? undefined : CLASS_FIELD[classification];
}

const NO_COUNTS: ImportResultCounts = {
  rows: 0,
  created: 0,
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

type RowGroup = {
  classification: PeopleImportRowClass | null;
  outcome: PeopleImportOutcome | null;
  writeState: PeopleImportWriteState | null;
  outcomeReason: string | null;
  _count: { _all: number };
};

/** Soma um grupo: reserva só em `writing`; o resto pelo campo da linha. */
function addGroup(counts: ImportResultCounts, group: RowGroup): void {
  const total = group._count._all;
  counts.rows += total;
  if (group.writeState === 'RESERVED') {
    counts.writing += total;
    return;
  }
  const field = countField(group.classification, group.outcome);
  if (field !== undefined) counts[field] += total;
  if (
    group.outcome === 'FAILED' &&
    group.outcomeReason === ROW_TEXT.phoneTaken
  ) {
    counts.phoneTaken += total;
  }
}

/**
 * Contagens do lote numa leitura só (EX13, CX11): um único `groupBy` é uma
 * foto das linhas, então a linha que o dono finaliza durante a contagem entra
 * em `writing` ou no resultado, nunca nos dois nem em nenhum. `writing` soma
 * toda reserva (`RESERVED`); `phoneTaken` ⊂ `failed`, pelo texto do motivo
 * (EX17.3), sem coluna nova.
 */
async function countRows(
  client: Client,
  batchId: string,
): Promise<ImportResultCounts> {
  const groups = await client.peopleImportRow.groupBy({
    by: ['classification', 'outcome', 'writeState', 'outcomeReason'],
    where: { batchId },
    _count: { _all: true },
  });
  const counts = { ...NO_COUNTS };
  for (const group of groups) addGroup(counts, group);
  return counts;
}

/** Linhas a encerrar: pendentes (só no encerramento) e reservas vencidas. */
function openRows(
  batchId: string,
  now: Date,
  withPending: boolean,
): Prisma.PeopleImportRowWhereInput {
  const expired: Prisma.PeopleImportRowWhereInput = {
    writeState: 'RESERVED',
    reservedUntil: { lt: now },
  };
  return {
    batchId,
    OR: withPending ? [{ writeState: 'PENDING' }, expired] : [expired],
  };
}

/**
 * m8 (EX13): linha de criação cuja pessoa já existe pelo `personId` da própria
 * linha (EX17.4 a) foi gravada; a reserva só venceu antes de `finalizeRow`.
 * Na atualização `personId` é a pessoa da prévia e não prova gravação.
 */
async function createdRowIds(
  tx: Client,
  open: Prisma.PeopleImportRowWhereInput,
): Promise<string[]> {
  const candidates = await tx.peopleImportRow.findMany({
    where: { ...open, classification: 'CREATE', personId: { not: null } },
    select: { id: true, personId: true },
  });
  if (candidates.length === 0) return [];
  const people = await tx.user.findMany({
    where: { id: { in: candidates.map((row) => row.personId as string) } },
    select: { id: true },
  });
  const existing = new Set(people.map((person) => person.id));
  return candidates
    .filter((row) => existing.has(row.personId as string))
    .map((row) => row.id);
}

/**
 * Fecha as linhas abertas: criação já gravada → `CREATED` (sem colunas nem
 * plano); o resto → `NOT_WRITTEN`, com as colunas mapeadas e sem o plano
 * (EX14). Cada `updateMany` repete o filtro, então uma linha que o dono acabou
 * de finalizar (ou reservar de novo) fica como está. Devolve quantas fechou.
 */
async function settleRows(
  tx: Client,
  open: Prisma.PeopleImportRowWhereInput,
): Promise<number> {
  const ids = await createdRowIds(tx, open);
  const created = await tx.peopleImportRow.updateMany({
    where: { ...open, id: { in: ids } },
    data: {
      writeState: 'DONE',
      outcome: 'CREATED',
      cells: Prisma.DbNull,
      plan: Prisma.DbNull,
    },
  });
  const notWritten = await tx.peopleImportRow.updateMany({
    where: open,
    data: {
      writeState: 'DONE',
      outcome: 'NOT_WRITTEN',
      outcomeReason: ROW_TEXT.notWrittenClosed,
      plan: Prisma.DbNull,
    },
  });
  return created.count + notWritten.count;
}

function storedWriting(result: Prisma.JsonValue | null): number {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) {
    return 0;
  }
  return typeof result.writing === 'number' ? result.writing : 0;
}

@Injectable()
export class PeopleImportCloseRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Conclui o lote uma vez só (EX13): sem linha `PENDING` nem `RESERVED`
   * (reserva vencida ainda conta: outro pedido pode retomá-la), o `updateMany`
   * condicional a `WRITING` decide; dois blocos terminando juntos, o segundo
   * espera o primeiro e não acha mais o lote. A trilha vai na mesma transação.
   */
  async completeIfDone(input: {
    batchId: string;
    now: Date;
    trail: TrailWriter<ImportResultCounts>;
  }): Promise<boolean> {
    const { batchId, now } = input;
    return this.prisma.$transaction(async (tx) => {
      const open = await tx.peopleImportRow.count({
        where: { batchId, writeState: { in: ['PENDING', 'RESERVED'] } },
      });
      if (open > 0) return false;
      const counts = await countRows(tx, batchId);
      const flipped = await tx.peopleImportBatch.updateMany({
        where: { id: batchId, status: 'WRITING' },
        data: { status: 'COMPLETED', finishedAt: now, result: counts },
      });
      if (flipped.count === 0) return false;
      await input.trail(tx, counts);
      return true;
    }, TX_OPTIONS);
  }

  /**
   * Encerra o lote (EX13, EX14): `WRITING → CLOSED` condicional, pendentes e
   * reservas vencidas fechadas pelo `settleRows`; reserva viva fica com o dono
   * e entra em `writing` (depois do `settleRows` com `now` fixo, e sem reserva
   * nova em `CLOSED`, toda reserva que sobra é viva). `null` = o lote não
   * estava em `WRITING`.
   */
  async close(input: {
    batchId: string;
    closedById: string;
    now: Date;
    trail: TrailWriter<ImportResultCounts>;
  }): Promise<ImportResultCounts | null> {
    const { batchId, now } = input;
    return this.prisma.$transaction(async (tx) => {
      const flipped = await tx.peopleImportBatch.updateMany({
        where: { id: batchId, status: 'WRITING' },
        data: {
          status: 'CLOSED',
          closedById: input.closedById,
          finishedAt: now,
        },
      });
      if (flipped.count === 0) return null;
      await settleRows(tx, openRows(batchId, now, true));
      const counts = await countRows(tx, batchId);
      await tx.peopleImportBatch.update({
        where: { id: batchId },
        data: { result: counts },
      });
      await input.trail(tx, counts);
      return counts;
    }, TX_OPTIONS);
  }

  /**
   * Lote `CLOSED`: as reservas vencidas viram `NOT_WRITTEN` (ou `CREATED`, m8).
   * Devolve quantas linhas fechou. O `result` do lote é refeito quando algo
   * mudou ou quando ele ainda guardava reserva viva (que o dono pode ter
   * finalizado depois do encerramento). Guardado com `writing` 0, ele é final:
   * a contagem é uma foto só e em `CLOSED` não nasce reserva nem pendente.
   */
  async settleExpired(batchId: string, now: Date): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      const batch = await tx.peopleImportBatch.findFirst({
        where: { id: batchId, status: 'CLOSED' },
        select: { result: true },
      });
      if (batch === null) return 0;
      const settled = await settleRows(tx, openRows(batchId, now, false));
      if (settled > 0 || storedWriting(batch.result) > 0) {
        await tx.peopleImportBatch.update({
          where: { id: batchId },
          data: { result: await countRows(tx, batchId) },
        });
      }
      return settled;
    }, TX_OPTIONS);
  }

  /** Lotes `WRITING` sem bloco (ou, sem bloco algum, sem confirmação) desde `cutoff`. */
  async staleWriting(
    cutoff: Date,
  ): Promise<{ id: string; confirmedById: string; fileName: string }[]> {
    const batches = await this.prisma.peopleImportBatch.findMany({
      where: {
        status: 'WRITING',
        confirmedById: { not: null },
        OR: [
          { lastBlockAt: { lt: cutoff } },
          { lastBlockAt: null, confirmedAt: { lt: cutoff } },
        ],
      },
      orderBy: [{ confirmedAt: 'asc' }, { id: 'asc' }],
      select: { id: true, confirmedById: true, fileName: true },
    });
    return batches.map((batch) => ({
      id: batch.id,
      confirmedById: batch.confirmedById as string,
      fileName: batch.fileName,
    }));
  }

  /**
   * Contagens para exibir o lote: `writing` só com reserva viva
   * (`reservedUntil >= now`); a vencida, que `reserveNextRow` retoma, conta como
   * pendente. As duas consultas leem a mesma foto (`REPEATABLE READ`, só
   * leitura), então a reserva finalizada no meio não é contada fora de lugar.
   */
  async resultCounts(
    batchId: string,
    now: Date = new Date(),
  ): Promise<ImportResultCounts> {
    return this.prisma.$transaction(
      async (tx) => {
        const counts = await countRows(tx, batchId);
        const expired = await tx.peopleImportRow.count({
          where: {
            batchId,
            writeState: 'RESERVED',
            reservedUntil: { lt: now },
          },
        });
        return { ...counts, writing: counts.writing - expired };
      },
      { ...TX_OPTIONS, isolationLevel: SNAPSHOT },
    );
  }
}
