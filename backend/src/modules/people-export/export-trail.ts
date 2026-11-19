import type {
  AuditChange,
  AuditRef,
  AuditValue,
  FieldChange,
} from '../../shared/audit/audit-change';
import type { CivilDate } from '../staff-schedule/civil-date';

// Exportação não grava pessoa nem vínculo: o único rastro é este evento, só com
// filtros e contagem (nenhum dado de quem saiu na planilha). Valores como dado
// (códigos, datas AAAA-MM-DD); o front traduz. `before` sempre nulo: a resposta
// da trilha devolve `changes`, não `metadata`. Nenhum campo se chama `phone` ou
// `email` (o `recordChange` mascararia pelo nome).

export type PhoneVisibility = 'full' | 'masked' | 'partial';
type ExportFormat = 'csv' | 'xlsx';

const ALL_SECTORS = 'Todos os setores';
const ALL_SHIFTS = 'Todos os turnos';

function created(field: string, after: AuditValue): FieldChange {
  return { field, before: null, after };
}

function formatLabel(format: ExportFormat): 'CSV' | 'XLSX' {
  return format === 'csv' ? 'CSV' : 'XLSX';
}

/** `categoryOfAction` não conhece `people.export`: a categoria vai explícita. */
function exportEvent(
  action: string,
  entityId: string | null,
  actorId: string,
  changes: FieldChange[],
): AuditChange {
  return {
    action,
    entity: 'Spreadsheet',
    entityId,
    category: 'SPREADSHEET',
    subjectUserId: null,
    reason: null,
    changes,
    actorId,
  };
}

export function peopleExportChange(input: {
  actorId: string;
  format: ExportFormat;
  sector: AuditRef | null;
  shift: AuditRef | null;
  status: 'active' | 'inactive' | 'all';
  date: CivilDate;
  rowCount: number;
  phoneVisibility: PhoneVisibility;
}): AuditChange {
  return exportEvent('people.export', null, input.actorId, [
    created('format', formatLabel(input.format)),
    created('sector', input.sector ?? ALL_SECTORS),
    created('shift', input.shift ?? ALL_SHIFTS),
    created('statusFilter', input.status),
    created('referenceDate', input.date),
    created('rowCount', input.rowCount),
    created('phoneVisibility', input.phoneVisibility),
  ]);
}

export function scheduleExportChange(input: {
  actorId: string;
  format: ExportFormat;
  sector: AuditRef;
  from: CivilDate;
  to: CivilDate;
  rowCount: number;
}): AuditChange {
  return exportEvent('schedule.export', input.sector.id, input.actorId, [
    created('format', formatLabel(input.format)),
    created('sector', input.sector),
    created('periodFrom', input.from),
    created('periodTo', input.to),
    created('rowCount', input.rowCount),
  ]);
}

/** Sem `telefone.ver_completo` → masked; ADMIN → full; gestor com a chave → partial. */
export function phoneVisibilityOf(viewer: {
  isAdmin: boolean;
  fullPhone: boolean;
}): PhoneVisibility {
  if (!viewer.fullPhone) return 'masked';
  return viewer.isAdmin ? 'full' : 'partial';
}
