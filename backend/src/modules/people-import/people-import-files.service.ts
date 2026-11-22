import { Injectable, Logger } from '@nestjs/common';
import {
  hasPermission,
  permissionDenied,
} from '../../shared/authz/permissions';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { CsvStreamWriter } from '../../shared/spreadsheet/csv-writer';
import {
  failDownload,
  setDownloadHeaders,
  type DownloadSink,
} from '../../shared/spreadsheet/download';
import {
  openSpreadsheet,
  type SpreadsheetFormat,
} from '../../shared/spreadsheet/spreadsheet-writer';
import { todayIn, type CivilDate } from '../staff-schedule/civil-date';
import { loadImportActor } from './import-actor';
import { templateInstructionRows, templateRows } from './import-template';
import { mappedColumns } from './mapping';
import { PeopleImportCloseRepository } from './people-import-close.repository';
import { PeopleImportQueryService } from './people-import-query.service';
import {
  PeopleImportRepository,
  type BatchRecord,
  type ReportRow,
} from './people-import.repository';

/** Linhas do relatório lidas e escritas por página (EX23). */
export const REPORT_PAGE_SIZE = 500;

const TEMPLATE_ROUTE = '/internal/people-import/template';
const REPORT_ROUTE = '/internal/people-import/batches/:id/errors.csv';
const PEOPLE_SHEET = 'Pessoas';
const INSTRUCTIONS_SHEET = 'Instruções';

/** Motivo da linha: os da prévia unidos por `; `; sem eles, o da gravação. */
function reasonOf(row: ReportRow): string {
  return row.reasons.length > 0
    ? row.reasons.join('; ')
    : (row.outcomeReason ?? '');
}

/**
 * Só as colunas mapeadas saem, na ordem do arquivo: na prévia `cells` ainda
 * traz as não mapeadas. O texto sai como veio do arquivo (o telefone também);
 * o escritor do Lote D põe o apóstrofo de fórmula.
 */
function reportCells(row: ReportRow, columns: readonly number[]): string[] {
  const cells = row.cells ?? {};
  return [
    String(row.rowNumber),
    ...columns.map((column) => cells[String(column)] ?? ''),
    reasonOf(row),
  ];
}

/**
 * Modelo de importação (E2) e relatório de erros do lote (E7). Ordem do
 * download (GX10): ator e lote conferidos → 1ª página lida → headers → bytes;
 * erro depois dos headers encerra a conexão (`failDownload`).
 */
@Injectable()
export class PeopleImportFilesService {
  private readonly logger = new Logger(PeopleImportFilesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: PeopleImportRepository,
    private readonly closeRepo: PeopleImportCloseRepository,
    private readonly query: PeopleImportQueryService,
  ) {}

  async template(format: SpreadsheetFormat, sink: DownloadSink): Promise<void> {
    try {
      const today = todayIn(new Date());
      setDownloadHeaders(sink, {
        format,
        fileName: `modelo-importacao-pessoas.${format}`,
      });
      const writer = openSpreadsheet({
        sink,
        format,
        firstSheet: PEOPLE_SHEET,
      });
      for (const cells of templateRows(today)) await writer.writeRow(cells);
      if (format === 'xlsx') {
        writer.startSheet(INSTRUCTIONS_SHEET);
        for (const cells of templateInstructionRows()) {
          await writer.writeRow(cells);
        }
      }
      await writer.close();
    } catch (error) {
      failDownload({ sink, error, logger: this.logger, route: TEMPLATE_ROUTE });
    }
  }

  /**
   * EX23/GX9: lote alheio e inexistente dão o mesmo 404 antes de qualquer
   * header. A chave também é conferida aqui, além do guard da rota (E7: o
   * relatório traz telefones e dados do arquivo). Lote encerrado acerta as
   * reservas vencidas antes de ler (EX13).
   */
  async errorReport(
    actorId: string,
    batchId: string,
    sink: DownloadSink,
  ): Promise<void> {
    const actor = await loadImportActor(this.prisma, actorId);
    if (!hasPermission(actor.policy, 'pessoas.importar')) {
      throw permissionDenied('pessoas.importar');
    }
    const batch = await this.query.visibleBatch(actor, batchId);
    const now = new Date();
    if (batch.status === 'CLOSED') {
      await this.closeRepo.settleExpired(batch.id, now);
    }
    try {
      await this.sendReport({ batch, sink, today: todayIn(now) });
    } catch (error) {
      failDownload({ sink, error, logger: this.logger, route: REPORT_ROUTE });
    }
  }

  private async sendReport(input: {
    batch: BatchRecord;
    sink: DownloadSink;
    today: CivilDate;
  }): Promise<void> {
    const { batch, sink } = input;
    const columns = mappedColumns(batch.mapping);
    let page = await this.repo.reportRows(batch.id, 0, REPORT_PAGE_SIZE);
    setDownloadHeaders(sink, {
      format: 'csv',
      fileName: `erros-importacao-${input.today}.csv`,
    });
    const writer = new CsvStreamWriter(sink);
    await writer.writeRow([
      'linha',
      ...columns.map((column) => batch.headers[column] ?? ''),
      'motivo',
    ]);
    for (;;) {
      for (const row of page) await writer.writeRow(reportCells(row, columns));
      const last = page.at(-1);
      if (page.length < REPORT_PAGE_SIZE || last === undefined) break;
      page = await this.repo.reportRows(
        batch.id,
        last.rowNumber,
        REPORT_PAGE_SIZE,
      );
    }
    await writer.close();
  }
}
