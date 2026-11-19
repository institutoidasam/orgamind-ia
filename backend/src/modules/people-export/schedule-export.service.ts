import { Injectable, Logger } from '@nestjs/common';
import type { ScheduleExportQuery } from '../../schemas/contracts/people-export.schema';
import type { StaffScheduleBoard } from '../../schemas/contracts/staff-schedule.schema';
import { AuditService } from '../../shared/audit/audit.service';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { formatDateCell } from '../../shared/spreadsheet/cell-rules';
import {
  failDownload,
  setDownloadHeaders,
  type DownloadSink,
} from '../../shared/spreadsheet/download';
import { fileSlug } from '../../shared/spreadsheet/file-name';
import {
  openSpreadsheet,
  type SpreadsheetFormat,
} from '../../shared/spreadsheet/spreadsheet-writer';
import { addDays, diffDays } from '../staff-schedule/civil-date';
import { StaffScheduleService } from '../staff-schedule/staff-schedule.service';
import { scheduleExportChange } from './export-trail';
import { exportSectorNotFound, scheduleTooLarge } from './people-export.errors';
import {
  SCHEDULE_FIXED_COLUMNS,
  scheduleCellLabel,
  scheduleFixedCells,
} from './schedule-cells';
import { findSectorName } from './sector-name.query';

const SHEET_NAME = 'Escala';
const ROUTE = '/internal/people-export/schedule';

type ScheduleTable = { header: string[]; body: string[][] };

/** Células do dia por data, nunca pela posição: dia que falta fica vazio. */
function buildTable(
  board: StaffScheduleBoard,
  query: ScheduleExportQuery,
): ScheduleTable {
  const dates = Array.from(
    { length: diffDays(query.to, query.from) + 1 },
    (_, index) => addDays(query.from, index),
  );
  const shiftNames = new Map(board.shifts.map((s) => [s.id, s.name]));
  const sectorNames = new Map(board.sectors.map((s) => [s.id, s.name]));
  const body = board.rows.map((row) => {
    const byDate = new Map(row.days.map((d) => [d.date, d.situation]));
    const cells = dates.map((date) => {
      const situation = byDate.get(date);
      if (!situation) return '';
      return scheduleCellLabel({
        situation,
        sectorId: query.sectorId,
        shiftNames,
        sectorNames,
      });
    });
    return [...scheduleFixedCells(row), ...cells];
  });
  return {
    header: [...SCHEDULE_FIXED_COLUMNS, ...dates.map(formatDateCell)],
    body,
  };
}

/**
 * Exportação da escala de um setor (D2). Quem confere permissão, alcance,
 * período (até 42 dias) e a máscara do nome é o quadro da Escala
 * (`StaffScheduleService.board`), chamado com o ator de quem pediu; o erro dele
 * sobe como veio. Ordem (DX9): quadro, corte, trilha, headers, bytes.
 */
@Injectable()
export class ScheduleExportService {
  private readonly logger = new Logger(ScheduleExportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly schedule: StaffScheduleService,
    private readonly audit: AuditService,
  ) {}

  /** Devolve as linhas de pessoa escritas; menos que o `rowCount` da trilha se a conexão cair. */
  async exportSchedule(
    actorId: string,
    query: ScheduleExportQuery,
    sink: DownloadSink,
  ): Promise<number> {
    const { format, sectorId, from, to } = query;
    const board = await this.schedule.board(actorId, { sectorId, from, to });
    if (board.truncated) throw scheduleTooLarge();
    const sectorName = await findSectorName(this.prisma, sectorId);
    if (sectorName === null) throw exportSectorNotFound();
    const table = buildTable(board, query);
    await this.prisma.$transaction((tx) =>
      this.audit.recordChange(
        tx,
        scheduleExportChange({
          actorId,
          format,
          sector: { id: sectorId, name: sectorName },
          from,
          to,
          rowCount: table.body.length,
        }),
      ),
    );
    const fileName = `escala-${fileSlug(sectorName)}-${from}-a-${to}.${format}`;
    setDownloadHeaders(sink, { format, fileName });
    return this.send(sink, format, table);
  }

  private async send(
    sink: DownloadSink,
    format: SpreadsheetFormat,
    table: ScheduleTable,
  ): Promise<number> {
    let written = 0;
    try {
      const writer = openSpreadsheet({ sink, format, firstSheet: SHEET_NAME });
      await writer.writeRow(table.header);
      for (const cells of table.body) {
        await writer.writeRow(cells);
        written += 1;
      }
      await writer.close();
    } catch (error) {
      // Sem headers enviados relança; com eles, encerra a resposta e volta.
      failDownload({ sink, error, logger: this.logger, route: ROUTE });
      return written;
    }
    return written;
  }
}
