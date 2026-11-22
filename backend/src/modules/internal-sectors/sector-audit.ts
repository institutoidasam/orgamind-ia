import type { Prisma } from '@prisma/client';
import {
  diffFields,
  type AuditValue,
  type FieldChange,
} from '../../shared/audit/audit-change';

/**
 * O que a trilha do setor guarda (A5): nome, gestor e ativo. O gestor sai só
 * como `{ id, name }` (GC2): nada de telefone nem e-mail da pessoa.
 */
export const sectorAuditSelect = {
  id: true,
  name: true,
  isActive: true,
  manager: { select: { id: true, name: true } },
} satisfies Prisma.SectorSelect;

export type SectorAuditRow = Prisma.SectorGetPayload<{
  select: typeof sectorAuditSelect;
}>;

function auditFields(row: SectorAuditRow): Record<string, AuditValue> {
  return {
    name: row.name,
    // Copia só id e nome: a linha de origem pode trazer mais colunas do gestor.
    // `User.name` é opcional; sem nome fica '' (o id continua identificando).
    manager: row.manager
      ? { id: row.manager.id, name: row.manager.name ?? '' }
      : null,
    isActive: row.isActive,
  };
}

/** Campos alterados (GC3); `before` nulo = criação, lista os não nulos. */
export function sectorAuditChanges(
  before: SectorAuditRow | null,
  after: SectorAuditRow,
): FieldChange[] {
  return diffFields(before ? auditFields(before) : null, auditFields(after));
}
