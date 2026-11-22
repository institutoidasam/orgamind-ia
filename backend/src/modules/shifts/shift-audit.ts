import type { Prisma } from '@prisma/client';
import {
  diffFields,
  type AuditValue,
  type FieldChange,
} from '../../shared/audit/audit-change';

/** O que a trilha do turno guarda (E8): nome, horário e ativo. A ordem tem trilha própria. */
export const shiftAuditSelect = {
  id: true,
  name: true,
  startTime: true,
  endTime: true,
  isActive: true,
} satisfies Prisma.ShiftSelect;

export type ShiftAuditRow = Prisma.ShiftGetPayload<{
  select: typeof shiftAuditSelect;
}>;

// Copia campo a campo: a linha de origem pode trazer mais colunas (sortOrder).
function auditFields(row: ShiftAuditRow): Record<string, AuditValue> {
  return {
    name: row.name,
    startTime: row.startTime,
    endTime: row.endTime,
    isActive: row.isActive,
  };
}

/** Campos alterados; `before` nulo = criação, lista os valores iniciais. */
export function shiftAuditChanges(
  before: ShiftAuditRow | null,
  after: ShiftAuditRow,
): FieldChange[] {
  return diffFields(before ? auditFields(before) : null, auditFields(after));
}
