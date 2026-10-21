import type { WorkShift } from '@prisma/client';

export const SHIFT_LABEL: Record<WorkShift, string> = {
  FIRST: '1º turno',
  SECOND: '2º turno',
};

/**
 * Filtro do alvo setor sobre os membros ATIVOS atuais. `null` = seleção inválida
 * (algum id fora do setor/turno, inativo ou inexistente). Ids repetidos contam uma vez.
 */
export function selectMembers<
  M extends { id: string; shift: WorkShift | null },
>(
  members: readonly M[],
  shift: WorkShift | undefined,
  userIds: readonly string[] | undefined,
): M[] | null {
  const inShift = shift
    ? members.filter((m) => m.shift === shift)
    : [...members];
  if (!userIds) return inShift;
  const wanted = new Set(userIds);
  const picked = inShift.filter((m) => wanted.has(m.id));
  return picked.length === wanted.size ? picked : null;
}

/** "Produção · 2º turno", "Produção · todos os turnos", "… · seleção de 2". */
export function sectorTargetLabel(
  sectorName: string,
  shift: WorkShift | null,
  selectedCount: number | null,
): string {
  const parts = [sectorName, shift ? SHIFT_LABEL[shift] : 'todos os turnos'];
  if (selectedCount !== null) parts.push(`seleção de ${selectedCount}`);
  return parts.join(' · ');
}
