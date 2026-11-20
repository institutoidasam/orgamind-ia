import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  BatchSummary,
  ColumnMapping,
  RowClass,
} from '../../schemas/contracts/people-import.schema';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { readCsvSheet } from '../../shared/spreadsheet/csv-reader';
import {
  IMPORT_MAX_BYTES,
  SheetReadError,
  type SheetData,
} from '../../shared/spreadsheet/sheet-data';
import { readXlsxSheet } from '../../shared/spreadsheet/xlsx-reader';
import { normalizeXlsxForExceljs } from '../excel-import/xlsx-normalizer';
import { todayIn } from '../staff-schedule/civil-date';
import { BatchClassifier } from './batch-classifier';
import { rowCellsOf } from './cell-values';
import {
  assertCanWrite,
  loadImportActor,
  type ImportActor,
} from './import-actor';
import type { RowCells } from './import-person';
import { mappingProblem, suggestMapping } from './mapping';
import { PeopleImportConfirmService } from './people-import-confirm.service';
import { PeopleImportQueryService } from './people-import-query.service';
import {
  importFileTooLarge,
  importInvalidFile,
  importUnreadable,
  mappingIncomplete,
  notInPreview,
  notUploader,
} from './people-import.errors';
import {
  PeopleImportRepository,
  type RowRecord,
} from './people-import.repository';
import {
  formatOf,
  fromSheetReadError,
  uploadedFileName,
} from './upload-format';

/** EX14/EX13: prévia e gravação parada há mais que isso saem no envio de um arquivo novo. */
const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

const logger = new Logger('PeopleImportPreviewService');

/** `originalName` cru do multer (latin1); `buffer` é o arquivo inteiro, que não é guardado (E2). */
export type UploadedSheet = {
  originalName: string;
  size: number;
  buffer: Buffer;
};

type SheetFormat = 'csv' | 'xlsx';
type CellRow = { rowNumber: number; cells: RowCells };
type Classified = {
  rows: RowRecord[];
  counts: Record<RowClass, number> | null;
};

/** EX4: tipo antes do tamanho; o MIME do navegador não é usado. */
function assertUploadable(file: UploadedSheet): SheetFormat {
  const format = formatOf(file.originalName, file.buffer);
  if (format === null) throw importInvalidFile();
  if (file.size > IMPORT_MAX_BYTES || file.buffer.length > IMPORT_MAX_BYTES) {
    throw importFileTooLarge();
  }
  return format;
}

/**
 * Entrada não confiável: toda falha da leitura vira 422. A falha inesperada sai
 * com o texto genérico e o log é fixo: a mensagem do erro pode trazer conteúdo
 * do arquivo, e o filtro global a gravaria num 500 (GX17).
 */
async function readSheet(
  format: SheetFormat,
  buffer: Buffer,
): Promise<SheetData> {
  try {
    if (format === 'csv') return readCsvSheet(buffer);
    return await readXlsxSheet(buffer, { repair: normalizeXlsxForExceljs });
  } catch (error) {
    if (error instanceof SheetReadError) throw fromSheetReadError(error);
    logger.warn('people_import.unreadable: falha inesperada na leitura');
    throw importUnreadable();
  }
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * Envio, remapeamento e descarte de um lote em prévia (spec E2, E3, E5; CX12).
 * O ator é relido a cada pedido e as travas de quem não é ADMIN são conferidas
 * com as permissões de agora (GX6); lote inexistente ou alheio responde o mesmo
 * 404 (GX9, pelo `visibleBatch`). Nenhum log leva célula nem nome de arquivo.
 */
@Injectable()
export class PeopleImportPreviewService {
  // Injetado por propriedade: o construtor já tem 4 dependências, o teto de
  // parâmetros. Resolvido pelo Nest antes do primeiro pedido.
  @Inject(PeopleImportConfirmService)
  private readonly confirmService!: PeopleImportConfirmService;

  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: PeopleImportRepository,
    private readonly classifier: BatchClassifier,
    private readonly query: PeopleImportQueryService,
  ) {}

  /**
   * Ator → tipo → tamanho → leitura → limpeza → sugestão → classificação →
   * lote. Nada é gravado antes de a leitura terminar bem; o arquivo em si não é
   * guardado, só o nome, o tamanho, o SHA-256 e as linhas lidas (E2).
   */
  async upload(actorId: string, file: UploadedSheet): Promise<BatchSummary> {
    const actor = await loadImportActor(this.prisma, actorId);
    assertCanWrite(actor);
    const format = assertUploadable(file);
    const sheet = await readSheet(format, file.buffer);
    const now = new Date();
    await this.cleanUp(now);
    const mapping = suggestMapping(sheet.headers);
    const rows = sheet.rows.map((row) => ({
      rowNumber: row.rowNumber,
      cells: rowCellsOf(row.cells),
    }));
    const classified = await this.classifyIfComplete({
      actor,
      mapping,
      rows,
      headerCount: sheet.headers.length,
      now,
    });
    const batchId = await this.repo.createBatch(
      {
        fileName: uploadedFileName(file.originalName),
        fileSize: file.size,
        fileSha256: sha256(file.buffer),
        format,
        headers: sheet.headers,
        mapping,
        previewCounts: classified.counts,
        createdById: actor.id,
      },
      classified.rows,
    );
    // Relido para trazer status e data do banco (um descarte já pode tê-lo apagado: 404).
    const batch = await this.query.visibleBatch(actor, batchId);
    return this.query.summaryFor(actor, batch);
  }

  /**
   * E3/EX6: refaz a prévia com o mapeamento novo. Só quem enviou (inclusive o
   * ADMIN, EX25), com `assertCanWrite` de agora, e só em prévia; a nova
   * classificação usa o alcance e as chaves de agora.
   */
  async remap(
    actorId: string,
    batchId: string,
    mapping: ColumnMapping,
  ): Promise<BatchSummary> {
    const actor = await loadImportActor(this.prisma, actorId);
    const batch = await this.query.visibleBatch(actor, batchId);
    if (batch.createdById !== actor.id) throw notUploader();
    assertCanWrite(actor);
    if (batch.status !== 'PREVIEW') throw notInPreview();
    const problem = mappingProblem(mapping, {
      headerCount: batch.headers.length,
      isAdmin: actor.isAdmin,
    });
    if (problem !== null) throw mappingIncomplete(problem);
    const cells = await this.repo.readRowCells(batch.id);
    const { rows, counts } = await this.classifier.classify({
      rows: cells,
      mapping,
      actor,
      today: todayIn(new Date()),
    });
    const replaced = await this.repo.replaceRows(batch.id, {
      mapping,
      previewCounts: counts,
      rows,
    });
    if (!replaced) return this.lostRace(actor, batch.id);
    return this.query.summaryFor(actor, {
      ...batch,
      mapping,
      previewCounts: counts,
    });
  }

  /**
   * EX14/EX25: quem vê o lote o descarta, só em prévia; o lote e as linhas são
   * apagados, sem registro, e o lote passa a responder 404.
   */
  async discard(actorId: string, batchId: string): Promise<void> {
    const actor = await loadImportActor(this.prisma, actorId);
    const batch = await this.query.visibleBatch(actor, batchId);
    if (batch.status !== 'PREVIEW') throw notInPreview();
    if (!(await this.repo.deletePreview(batch.id))) {
      await this.lostRace(actor, batch.id);
    }
  }

  /** Outro pedido chegou antes da escrita condicional: o lote sumiu (404) ou saiu da prévia (409). */
  private async lostRace(actor: ImportActor, batchId: string): Promise<never> {
    await this.query.visibleBatch(actor, batchId);
    throw notInPreview();
  }

  /** EX14 e EX13 automático, a cada envio de arquivo novo. */
  private async cleanUp(now: Date): Promise<void> {
    await this.repo.deleteStalePreviews(
      new Date(now.getTime() - STALE_AFTER_MS),
    );
    await this.confirmService.closeStale(now);
  }

  /** EX30: com o mapeamento incompleto, as linhas ficam sem classificação. */
  private async classifyIfComplete(input: {
    actor: ImportActor;
    mapping: ColumnMapping;
    rows: CellRow[];
    headerCount: number;
    now: Date;
  }): Promise<Classified> {
    const problem = mappingProblem(input.mapping, {
      headerCount: input.headerCount,
      isAdmin: input.actor.isAdmin,
    });
    if (problem !== null) {
      return {
        rows: input.rows.map((row) => ({ ...row, verdict: null })),
        counts: null,
      };
    }
    return this.classifier.classify({
      rows: input.rows,
      mapping: input.mapping,
      actor: input.actor,
      today: todayIn(input.now),
    });
  }
}
