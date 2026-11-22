import { Injectable } from '@nestjs/common';
import {
  Prisma,
  type PeopleImportRowClass,
  type PeopleImportStatus,
} from '@prisma/client';
import {
  IMPORT_BATCHES_PAGE_SIZE,
  IMPORT_ROWS_PAGE_SIZE,
  type ColumnMapping,
  type RowClass,
} from '../../schemas/contracts/people-import.schema';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { fromDbDate } from '../staff-schedule/civil-date';
import type {
  ImportPerson,
  ImportResultCounts,
  RowCells,
  RowPreview,
  RowVerdict,
} from './import-person';
import type { StructureCatalog } from './structure-match';

export type RowRecord = {
  rowNumber: number;
  cells: RowCells;
  verdict: RowVerdict | null;
};

export type NewBatch = {
  fileName: string;
  fileSize: number;
  fileSha256: string;
  format: 'csv' | 'xlsx';
  headers: string[];
  mapping: ColumnMapping;
  previewCounts: Record<RowClass, number> | null;
  createdById: string;
};

export type BatchRecord = NewBatch & {
  id: string;
  status: PeopleImportStatus;
  createdAt: Date;
  confirmedById: string | null;
  confirmedAt: Date | null;
  lastBlockAt: Date | null;
  finishedAt: Date | null;
  closedById: string | null;
  result: ImportResultCounts | null;
};

export type StoredRow = {
  rowNumber: number;
  cells: RowCells | null;
  classification: RowClass | null;
  reasons: string[];
  warnings: string[];
  preview: RowPreview | null;
};

export type ReportRow = {
  rowNumber: number;
  cells: RowCells | null;
  reasons: string[];
  outcomeReason: string | null;
};

const CHUNK = 1000;
const TX_OPTIONS = { timeout: 30_000 };
// Linhas do relatório de erros (EX23): as de erro da prévia e as que falharam.
const ERROR_CLASSES: PeopleImportRowClass[] = [
  'INVALID',
  'DUPLICATE',
  'CONFLICT',
];

const PERSON_SELECT = {
  id: true,
  name: true,
  phoneE164: true,
  registration: true,
  registrationKey: true,
  jobTitle: true,
  sectorId: true,
  shiftId: true,
  levelId: true,
  contactAuthorization: true,
  authorizationSource: true,
  authorizationNote: true,
  authorizationDate: true,
  isActive: true,
  hasAccess: true,
} satisfies Prisma.UserSelect;

type PersonRow = Prisma.UserGetPayload<{ select: typeof PERSON_SELECT }>;

/** O JSON que o próprio repositório gravou volta tipado, sem interpretar o conteúdo. */
function asJson<T>(value: Prisma.JsonValue | null): T | null {
  return value === null ? null : (value as unknown as T);
}

function asStrings(value: Prisma.JsonValue): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function asCells(value: Prisma.JsonValue | null): RowCells | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as unknown as RowCells;
}

/** `null` vira NULL do banco (`Prisma.DbNull`), não o JSON `null`. */
function jsonOrNull<T extends Prisma.InputJsonValue>(
  value: T | null | undefined,
): T | typeof Prisma.DbNull {
  return value ?? Prisma.DbNull;
}

function chunksOf<T>(list: readonly T[]): T[][] {
  const chunks: T[][] = [];
  for (let at = 0; at < list.length; at += CHUNK) {
    chunks.push(list.slice(at, at + CHUNK));
  }
  return chunks;
}

const NO_VERDICT = {
  classification: null,
  reasons: [],
  warnings: [],
  preview: Prisma.DbNull,
  plan: Prisma.DbNull,
  personId: null,
};

/** Colunas da classificação; sem veredito (mapeamento incompleto) ficam vazias. */
function verdictData(verdict: RowVerdict | null) {
  if (verdict === null) return NO_VERDICT;
  return {
    classification: verdict.classification,
    reasons: verdict.reasons,
    warnings: verdict.warnings,
    preview: jsonOrNull(verdict.preview),
    plan: jsonOrNull(verdict.plan),
    personId: verdict.personId,
  };
}

function rowData(
  batchId: string,
  row: RowRecord,
): Prisma.PeopleImportRowCreateManyInput {
  return {
    batchId,
    rowNumber: row.rowNumber,
    cells: row.cells,
    ...verdictData(row.verdict),
  };
}

/** Grava as linhas em blocos de 1.000 (limite de parâmetros do Postgres). */
async function insertRows(
  tx: Prisma.TransactionClient,
  batchId: string,
  rows: readonly RowRecord[],
): Promise<void> {
  for (const block of chunksOf(rows)) {
    await tx.peopleImportRow.createMany({
      data: block.map((row) => rowData(batchId, row)),
    });
  }
}

function toBatchRecord(
  batch: Prisma.PeopleImportBatchGetPayload<object>,
): BatchRecord {
  return {
    id: batch.id,
    fileName: batch.fileName,
    fileSize: batch.fileSize,
    fileSha256: batch.fileSha256,
    format: batch.format as 'csv' | 'xlsx',
    headers: asStrings(batch.headers),
    mapping: batch.mapping as unknown as ColumnMapping,
    previewCounts: asJson(batch.previewCounts),
    status: batch.status,
    createdById: batch.createdById,
    createdAt: batch.createdAt,
    confirmedById: batch.confirmedById,
    confirmedAt: batch.confirmedAt,
    lastBlockAt: batch.lastBlockAt,
    finishedAt: batch.finishedAt,
    closedById: batch.closedById,
    result: asJson(batch.result),
  };
}

function toImportPerson(user: PersonRow): ImportPerson {
  return {
    id: user.id,
    name: user.name,
    phoneE164: user.phoneE164,
    registration: user.registration,
    registrationKey: user.registrationKey,
    jobTitle: user.jobTitle,
    sectorId: user.sectorId,
    shiftId: user.shiftId,
    levelId: user.levelId,
    authorization: {
      status: user.contactAuthorization,
      source: user.authorizationSource,
      note: user.authorizationNote,
      date:
        user.authorizationDate === null
          ? null
          : fromDbDate(user.authorizationDate),
    },
    isActive: user.isActive,
    hasAccess: user.hasAccess,
  };
}

/** Bloco `round` de cada lista; lista sem chave naquele bloco não entra no `OR`. */
function keyFilters(
  input: {
    registrationKeys: readonly string[];
    phones: readonly string[];
    ids?: readonly string[];
  },
  round: number,
): Prisma.UserWhereInput[] {
  const block = (list: readonly string[]) =>
    list.slice(round * CHUNK, (round + 1) * CHUNK);
  const registrationKeys = block(input.registrationKeys);
  const phones = block(input.phones);
  const ids = block(input.ids ?? []);
  return [
    ...(registrationKeys.length > 0
      ? [{ registrationKey: { in: registrationKeys } }]
      : []),
    ...(phones.length > 0 ? [{ phoneE164: { in: phones } }] : []),
    ...(ids.length > 0 ? [{ id: { in: ids } }] : []),
  ];
}

@Injectable()
export class PeopleImportRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Lote e linhas na mesma transação (EX6); devolve o id do lote. */
  async createBatch(
    batch: NewBatch,
    rows: readonly RowRecord[],
  ): Promise<string> {
    return this.prisma.$transaction(async (tx) => {
      const created = await tx.peopleImportBatch.create({
        data: {
          fileName: batch.fileName,
          fileSize: batch.fileSize,
          fileSha256: batch.fileSha256,
          format: batch.format,
          headers: batch.headers,
          mapping: batch.mapping,
          previewCounts: jsonOrNull(batch.previewCounts),
          createdById: batch.createdById,
        },
        select: { id: true },
      });
      await insertRows(tx, created.id, rows);
      return created.id;
    }, TX_OPTIONS);
  }

  /**
   * Remapear (EX6): troca mapeamento, contagens e linhas só com o lote em
   * `PREVIEW`. O `updateMany` condicional trava o lote até o commit, então uma
   * confirmação simultânea espera e nunca vê linhas pela metade; `false` = o
   * lote não está (mais) em prévia e nada mudou.
   */
  async replaceRows(
    batchId: string,
    input: {
      mapping: ColumnMapping;
      previewCounts: Record<RowClass, number> | null;
      rows: readonly RowRecord[];
    },
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.peopleImportBatch.updateMany({
        where: { id: batchId, status: 'PREVIEW' },
        data: {
          mapping: input.mapping,
          previewCounts: jsonOrNull(input.previewCounts),
        },
      });
      if (updated.count === 0) return false;
      await tx.peopleImportRow.deleteMany({ where: { batchId } });
      await insertRows(tx, batchId, input.rows);
      return true;
    }, TX_OPTIONS);
  }

  async findBatch(id: string): Promise<BatchRecord | null> {
    const batch = await this.prisma.peopleImportBatch.findUnique({
      where: { id },
    });
    return batch === null ? null : toBatchRecord(batch);
  }

  /** Linhas com conteúdo, em ordem de linha (o remapear as reclassifica). */
  async readRowCells(
    batchId: string,
  ): Promise<{ rowNumber: number; cells: RowCells }[]> {
    const rows = await this.prisma.peopleImportRow.findMany({
      where: { batchId },
      orderBy: { rowNumber: 'asc' },
      select: { rowNumber: true, cells: true },
    });
    return rows.flatMap((row) => {
      const cells = asCells(row.cells);
      return cells === null ? [] : [{ rowNumber: row.rowNumber, cells }];
    });
  }

  /** Página de `IMPORT_ROWS_PAGE_SIZE` linhas, em ordem de linha (EX6). */
  async pageRows(
    batchId: string,
    query: { page: number; classification?: RowClass },
  ): Promise<{ total: number; items: StoredRow[] }> {
    const where: Prisma.PeopleImportRowWhereInput = {
      batchId,
      ...(query.classification === undefined
        ? {}
        : { classification: query.classification }),
    };
    const [total, rows] = await Promise.all([
      this.prisma.peopleImportRow.count({ where }),
      this.prisma.peopleImportRow.findMany({
        where,
        orderBy: { rowNumber: 'asc' },
        skip: (query.page - 1) * IMPORT_ROWS_PAGE_SIZE,
        take: IMPORT_ROWS_PAGE_SIZE,
        select: {
          rowNumber: true,
          cells: true,
          classification: true,
          reasons: true,
          warnings: true,
          preview: true,
        },
      }),
    ]);
    const items = rows.map((row) => ({
      rowNumber: row.rowNumber,
      cells: asCells(row.cells),
      classification: row.classification,
      reasons: asStrings(row.reasons),
      warnings: asStrings(row.warnings),
      preview: asJson<RowPreview>(row.preview),
    }));
    return { total, items };
  }

  /** Mais recentes primeiro; `createdById` nulo = todos os lotes (ADMIN, GX9). */
  async listBatches(query: {
    createdById: string | null;
    page: number;
  }): Promise<{ total: number; items: BatchRecord[] }> {
    const where: Prisma.PeopleImportBatchWhereInput =
      query.createdById === null ? {} : { createdById: query.createdById };
    const [total, batches] = await Promise.all([
      this.prisma.peopleImportBatch.count({ where }),
      this.prisma.peopleImportBatch.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * IMPORT_BATCHES_PAGE_SIZE,
        take: IMPORT_BATCHES_PAGE_SIZE,
      }),
    ]);
    return { total, items: batches.map(toBatchRecord) };
  }

  /** Só prévia se descarta; as linhas saem em cascata. */
  async deletePreview(id: string): Promise<boolean> {
    const deleted = await this.prisma.peopleImportBatch.deleteMany({
      where: { id, status: 'PREVIEW' },
    });
    return deleted.count > 0;
  }

  /** EX14: prévias criadas antes de `cutoff`; devolve quantos lotes apagou. */
  async deleteStalePreviews(cutoff: Date): Promise<number> {
    const deleted = await this.prisma.peopleImportBatch.deleteMany({
      where: { status: 'PREVIEW', createdAt: { lt: cutoff } },
    });
    return deleted.count;
  }

  /**
   * Pessoas que casam com alguma chave (matrícula, telefone ou id), em blocos
   * de 1.000 por lista. Lista vazia não entra no `OR`: sem a chave de telefone
   * o chamador passa `phones: []` e nenhum número é consultado (EX17.3).
   */
  async findPeopleByKeys(input: {
    registrationKeys: readonly string[];
    phones: readonly string[];
    ids?: readonly string[];
  }): Promise<ImportPerson[]> {
    const rounds = Math.max(
      ...[input.registrationKeys, input.phones, input.ids ?? []].map((list) =>
        Math.ceil(list.length / CHUNK),
      ),
    );
    const found = new Map<string, ImportPerson>();
    for (let round = 0; round < rounds; round += 1) {
      const users = await this.prisma.user.findMany({
        where: { OR: keyFilters(input, round) },
        select: PERSON_SELECT,
      });
      for (const user of users) found.set(user.id, toImportPerson(user));
    }
    return [...found.values()];
  }

  /** Setor, turno e nível, ativos e inativos; só o setor tem `code`. */
  async loadCatalog(): Promise<StructureCatalog> {
    const select = { id: true, name: true, isActive: true };
    const [sectors, shifts, levels] = await Promise.all([
      this.prisma.sector.findMany({
        select: { ...select, code: true },
        orderBy: { name: 'asc' },
      }),
      this.prisma.shift.findMany({ select, orderBy: { name: 'asc' } }),
      this.prisma.staffLevel.findMany({ select, orderBy: { name: 'asc' } }),
    ]);
    const withoutCode = <T extends object>(options: T[]) =>
      options.map((option) => ({ ...option, code: null }));
    return {
      sector: sectors,
      shift: withoutCode(shifts),
      level: withoutCode(levels),
    };
  }

  /** Nome cru por id; quem não existe fica fora do mapa. */
  async userNames(ids: readonly string[]): Promise<Map<string, string | null>> {
    if (ids.length === 0) return new Map();
    const users = await this.prisma.user.findMany({
      where: { id: { in: [...new Set(ids)] } },
      select: { id: true, name: true },
    });
    return new Map(users.map((user) => [user.id, user.name]));
  }

  /**
   * Linhas que a confirmação deixou para gravar (`writeState` preenchido, em
   * qualquer estado): o `toWrite` do andamento, fixo depois da confirmação.
   */
  async toWriteCount(batchId: string): Promise<number> {
    return this.prisma.peopleImportRow.count({
      where: { batchId, writeState: { not: null } },
    });
  }

  /**
   * Linhas do relatório de erros (EX23): inválidas, repetidas e em conflito na
   * prévia, mais as que falharam ou ficaram sem gravar, depois de `after`.
   */
  async reportRows(
    batchId: string,
    after: number,
    take: number,
  ): Promise<ReportRow[]> {
    const rows = await this.prisma.peopleImportRow.findMany({
      where: {
        batchId,
        rowNumber: { gt: after },
        OR: [
          { classification: { in: ERROR_CLASSES } },
          { outcome: { in: ['FAILED', 'NOT_WRITTEN'] } },
        ],
      },
      orderBy: { rowNumber: 'asc' },
      take,
      select: {
        rowNumber: true,
        cells: true,
        reasons: true,
        outcomeReason: true,
      },
    });
    return rows.map((row) => ({
      rowNumber: row.rowNumber,
      cells: asCells(row.cells),
      reasons: asStrings(row.reasons),
      outcomeReason: row.outcomeReason,
    }));
  }
}
