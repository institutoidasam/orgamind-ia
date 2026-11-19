import { Injectable, Logger } from '@nestjs/common';
import {
  PEOPLE_EXPORT_ROW_CAP,
  type PeopleExportQuery,
} from '../../schemas/contracts/people-export.schema';
import type { AuditChange, AuditRef } from '../../shared/audit/audit-change';
import { AuditService } from '../../shared/audit/audit.service';
import { hasPermission } from '../../shared/authz/permissions';
import { PrismaService } from '../../shared/prisma/prisma.service';
import {
  failDownload,
  setDownloadHeaders,
  type DownloadSink,
} from '../../shared/spreadsheet/download';
import { PEOPLE_EXPORT_COLUMNS } from '../../shared/spreadsheet/people-columns';
import {
  openSpreadsheet,
  type SpreadsheetWriter,
} from '../../shared/spreadsheet/spreadsheet-writer';
import {
  addDays,
  todayIn,
  zonedStart,
  type CivilDate,
} from '../staff-schedule/civil-date';
import { findTeamActor } from '../team-whatsapp/team-actor.query';
import type { AssignmentLine } from '../users/assignment-timeline';
import { peopleExportChange, phoneVisibilityOf } from './export-trail';
import {
  exportSectorNotFound,
  exportShiftNotFound,
  noManagedSector,
  peopleTooLarge,
  sectorOutOfReach,
} from './people-export.errors';
import {
  PeopleExportRepository,
  type CandidateFilter,
} from './people-export.repository';
import { peopleInstructionRows } from './people-instructions';
import {
  comparePeopleEntries,
  peopleCells,
  selectIndexEntry,
  type ExportNameMaps,
  type ExportViewer,
  type PeopleCandidateRow,
  type PeopleIndexEntry,
  type PeopleSelection,
} from './people-rows';

/** Candidatos lidos por página na 1ª passada (DX4). */
export const PEOPLE_INDEX_PAGE = 1_000;

/** Linhas lidas e escritas por bloco na 2ª passada (DX4). */
export const PEOPLE_DETAIL_PAGE = 500;

const ROUTE = '/internal/people-export/people';
const PEOPLE_SHEET = 'Pessoas';
const INSTRUCTIONS_SHEET = 'Instruções';
const ALL_SECTORS = 'Todos os setores';
const ALL_SHIFTS = 'Todos os turnos';

export type PeopleExportPlan = {
  viewer: ExportViewer;
  /** `todayIn(new Date())`, lido uma única vez por exportação (GX6). */
  today: CivilDate;
  date: CivilDate;
  sector: AuditRef | null;
  shift: AuditRef | null;
  names: ExportNameMaps;
  /** Índice já ordenado por `comparePeopleEntries`; no máximo `PEOPLE_EXPORT_ROW_CAP`. */
  entries: PeopleIndexEntry[];
};

/**
 * DX9/DX12: ator válido e alcance. `reach` nunca é nulo para quem não é ADMIN:
 * é a lista (não vazia) de setores que ele gerencia.
 */
async function resolveViewer(
  prisma: PrismaService,
  actorId: string,
): Promise<ExportViewer> {
  const actor = await findTeamActor(prisma, actorId);
  if (!actor || !actor.isActive || !actor.hasAccess) throw sectorOutOfReach();
  const isAdmin = actor.role === 'ADMIN';
  if (!isAdmin && actor.managedSectorIds.length === 0) throw noManagedSector();
  return {
    isAdmin,
    fullPhone: hasPermission(actor, 'telefone.ver_completo'),
    reach: isAdmin ? null : [...actor.managedSectorIds],
  };
}

/**
 * Fora do alcance e inexistente dão o MESMO 403 (não revela se o setor existe);
 * só o ADMIN, que alcança tudo, recebe o 404.
 */
function pickSector(
  viewer: ExportViewer,
  names: ExportNameMaps,
  sectorId: string | undefined,
): AuditRef | null {
  if (!sectorId) return null;
  if (!viewer.isAdmin && !viewer.reach?.includes(sectorId)) {
    throw sectorOutOfReach();
  }
  const name = names.sectors.get(sectorId);
  if (name === undefined) throw exportSectorNotFound();
  return { id: sectorId, name };
}

/** Turnos não têm alcance: qualquer papel recebe o 404. */
function pickShift(
  names: ExportNameMaps,
  shiftId: string | undefined,
): AuditRef | null {
  if (!shiftId) return null;
  const name = names.shifts.get(shiftId);
  if (name === undefined) throw exportShiftNotFound();
  return { id: shiftId, name };
}

/** DX5: com data de hoje em diante o SQL já filtra pelo espelho; data passada, não. */
function candidateFilter(
  status: CandidateFilter['status'],
  selection: PeopleSelection,
): CandidateFilter {
  const { date, today } = selection;
  return {
    status,
    // Instante exclusivo: único corte contra quem foi cadastrado depois da data.
    createdBefore: zonedStart(addDays(date, 1), '00:00'),
    mirror:
      date >= today
        ? { sectorIds: selection.sectorIds, shiftId: selection.shiftId }
        : null,
  };
}

type IndexInput = {
  filter: CandidateFilter;
  selection: PeopleSelection;
  viewer: ExportViewer;
  names: ExportNameMaps;
};

/** Entradas de uma página; as linhas de vínculo só existem para data passada. */
async function pageEntries(
  repo: PeopleExportRepository,
  page: readonly PeopleCandidateRow[],
  input: IndexInput,
): Promise<PeopleIndexEntry[]> {
  const { selection, viewer, names } = input;
  const lines =
    selection.date < selection.today
      ? await repo.linesOn(
          page.map((row) => row.id),
          selection.date,
        )
      : new Map<string, AssignmentLine[]>();
  const entries: PeopleIndexEntry[] = [];
  for (const row of page) {
    const entry = selectIndexEntry({
      row,
      lines: lines.get(row.id) ?? [],
      selection,
      viewer,
      names,
    });
    if (entry) entries.push(entry);
  }
  return entries;
}

/** DX4, 1ª passada: páginas por cursor de `id`; para de ler ao passar do teto. */
async function readIndex(
  repo: PeopleExportRepository,
  input: IndexInput,
): Promise<PeopleIndexEntry[]> {
  const index: PeopleIndexEntry[] = [];
  let afterId: string | undefined;
  for (;;) {
    const page = await repo.pageCandidates(
      input.filter,
      PEOPLE_INDEX_PAGE,
      afterId,
    );
    index.push(...(await pageEntries(repo, page, input)));
    if (index.length > PEOPLE_EXPORT_ROW_CAP) throw peopleTooLarge();
    if (page.length < PEOPLE_INDEX_PAGE) return index;
    afterId = page[page.length - 1].id;
  }
}

/**
 * DX4, 2ª passada, um bloco: detalhes mapeados por id (`detailsByIds` volta em
 * ordem livre) e linhas na ordem do índice. Id que não voltou (pessoa apagada
 * entre as passadas) é omitido, sem erro. Telefone e nome por linha: `peopleCells`.
 */
async function blockRows(
  repo: PeopleExportRepository,
  plan: PeopleExportPlan,
  entries: readonly PeopleIndexEntry[],
): Promise<string[][]> {
  const details = await repo.detailsByIds(entries.map((entry) => entry.id));
  const byId = new Map(details.map((row) => [row.id, row]));
  const rows: string[][] = [];
  for (const entry of entries) {
    const detail = byId.get(entry.id);
    if (!detail) continue;
    rows.push(
      peopleCells({ viewer: plan.viewer, entry, detail, names: plan.names }),
    );
  }
  return rows;
}

/** Um bloco de linhas por vez: só o bloco corrente fica em memória. */
async function* rowBlocks(
  repo: PeopleExportRepository,
  plan: PeopleExportPlan,
): AsyncGenerator<string[][]> {
  const { entries } = plan;
  for (let start = 0; start < entries.length; start += PEOPLE_DETAIL_PAGE) {
    const page = entries.slice(start, start + PEOPLE_DETAIL_PAGE);
    yield await blockRows(repo, plan, page);
  }
}

/** DX13: só filtros, contagem do índice e visibilidade do telefone; nada de pessoa. */
function trailOf(
  actorId: string,
  query: PeopleExportQuery,
  plan: PeopleExportPlan,
): AuditChange {
  return peopleExportChange({
    actorId,
    format: query.format,
    sector: plan.sector,
    shift: plan.shift,
    status: query.status,
    date: plan.date,
    rowCount: plan.entries.length,
    phoneVisibility: phoneVisibilityOf(plan.viewer),
  });
}

/** Aba "Instruções" (só no XLSX): linhas de texto, inclusive a vazia entre as notas e a legenda. */
async function writeInstructions(
  writer: SpreadsheetWriter,
  query: PeopleExportQuery,
  plan: PeopleExportPlan,
): Promise<void> {
  writer.startSheet(INSTRUCTIONS_SHEET);
  const rows = peopleInstructionRows({
    exportedAt: new Date(),
    sectorLabel: plan.sector?.name ?? ALL_SECTORS,
    shiftLabel: plan.shift?.name ?? ALL_SHIFTS,
    status: query.status,
    date: plan.date,
    phoneVisibility: phoneVisibilityOf(plan.viewer),
  });
  for (const cells of rows) await writer.writeRow(cells);
}

/** Exportação de pessoas: plano (8a), trilha, headers e arquivo em blocos. */
@Injectable()
export class PeopleExportService {
  private readonly logger = new Logger(PeopleExportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: PeopleExportRepository,
    private readonly audit: AuditService,
  ) {}

  /** Ator → setor → turno → índice (DX9); lança 403, 404 ou 422 antes de qualquer escrita. */
  async planPeopleExport(
    actorId: string,
    query: PeopleExportQuery,
  ): Promise<PeopleExportPlan> {
    const today = todayIn(new Date());
    const date = query.date ?? today;
    const viewer = await resolveViewer(this.prisma, actorId);
    const names = await this.repo.nameMaps();
    const sector = pickSector(viewer, names, query.sectorId);
    const shift = pickShift(names, query.shiftId);
    const selection: PeopleSelection = {
      sectorIds: sector ? [sector.id] : viewer.reach,
      shiftId: shift?.id ?? null,
      date,
      today,
    };
    const filter = candidateFilter(query.status, selection);
    const index = await readIndex(this.repo, {
      filter,
      selection,
      viewer,
      names,
    });
    index.sort(comparePeopleEntries);
    return { viewer, today, date, sector, shift, names, entries: index };
  }

  /**
   * Ordem (DX9): plano (403/404/422 saem daqui, sem trilha e sem header) →
   * trilha numa transação que só tem o `recordChange` → headers e bytes, fora
   * dela. Se a trilha falhar o erro sobe e nada é enviado. Devolve as linhas de
   * pessoa escritas; menos que o `rowCount` da trilha se uma pessoa sumiu entre
   * as passadas ou a conexão caiu.
   */
  async exportPeople(
    actorId: string,
    query: PeopleExportQuery,
    sink: DownloadSink,
  ): Promise<number> {
    const plan = await this.planPeopleExport(actorId, query);
    await this.prisma.$transaction((tx) =>
      this.audit.recordChange(tx, trailOf(actorId, query, plan)),
    );
    return this.send({ sink, query, plan });
  }

  /**
   * O 1º bloco é lido ANTES dos headers e do escritor (o XLSX começa a mandar
   * bytes ao ser criado): falha de leitura ainda vira erro HTTP. Depois dos
   * headers, `failDownload` encerra a resposta sem relançar.
   */
  private async send(input: {
    sink: DownloadSink;
    query: PeopleExportQuery;
    plan: PeopleExportPlan;
  }): Promise<number> {
    const { sink, query, plan } = input;
    const { format } = query;
    let written = 0;
    try {
      const blocks = rowBlocks(this.repo, plan);
      let step = await blocks.next();
      setDownloadHeaders(sink, {
        format,
        fileName: `pessoas-${plan.today}.${format}`,
      });
      const writer = openSpreadsheet({
        sink,
        format,
        firstSheet: PEOPLE_SHEET,
      });
      await writer.writeRow([...PEOPLE_EXPORT_COLUMNS]);
      while (!step.done) {
        for (const cells of step.value) {
          await writer.writeRow(cells);
          written += 1;
        }
        step = await blocks.next();
      }
      if (format === 'xlsx') await writeInstructions(writer, query, plan);
      await writer.close();
    } catch (error) {
      failDownload({ sink, error, logger: this.logger, route: ROUTE });
      return written;
    }
    return written;
  }
}
