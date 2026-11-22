import type { Prisma } from '@prisma/client';
import {
  diffFields,
  type AuditChange,
  type AuditValue,
  type FieldChange,
} from '../../shared/audit/audit-change';

/** O que a trilha do nível guarda (E8): nome e ativo. A ordem tem trilha própria. */
export const levelAuditSelect = {
  id: true,
  name: true,
  isActive: true,
} satisfies Prisma.StaffLevelSelect;

export type LevelAuditRow = Prisma.StaffLevelGetPayload<{
  select: typeof levelAuditSelect;
}>;

// Copia campo a campo: a linha de origem pode trazer mais colunas (sortOrder).
function auditFields(row: LevelAuditRow): Record<string, AuditValue> {
  return { name: row.name, isActive: row.isActive };
}

/** Campos alterados; `before` nulo = criação, lista os valores iniciais. */
export function levelAuditChanges(
  before: LevelAuditRow | null,
  after: LevelAuditRow,
): FieldChange[] {
  return diffFields(before ? auditFields(before) : null, auditFields(after));
}

/**
 * Evento da trilha de estrutura do nível (E8). Sem campo alterado não há
 * evento (`null`): nada de linha vazia na trilha.
 */
export function levelEvent(
  action: string,
  actorId: string,
  entityId: string | null,
  changes: FieldChange[],
): AuditChange | null {
  if (changes.length === 0) return null;
  return {
    action,
    actorId,
    entityId,
    changes,
    entity: 'StaffLevel',
    category: 'STRUCTURE',
  };
}
