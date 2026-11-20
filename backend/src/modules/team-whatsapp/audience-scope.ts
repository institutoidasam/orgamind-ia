import type { ShiftRef } from '../../schemas/contracts/shift.schema';
import type { TeamShiftSnapshot } from '../../schemas/contracts/team-whatsapp.schema';
import type { LevelsRepository } from '../levels/levels.repository';
import type { SectorTargetInput } from './dto/create-team-dispatch.dto';
import { invalidLevel, invalidShift } from './team-whatsapp.errors';
import { pickLevels, type LevelFilter } from './team-whatsapp.roster';

/**
 * Sem `shiftIds` = todos os turnos ([]); com, todos precisam estar entre os
 * ativos (422 `invalid_shift`). Devolve na ordem de `listActiveShifts` (D9).
 */
export function requireShifts(
  active: readonly ShiftRef[],
  shiftIds: readonly string[] | undefined,
): TeamShiftSnapshot[] {
  if (shiftIds === undefined) return [];
  const wanted = new Set(shiftIds);
  const picked = active.filter((s) => wanted.has(s.id));
  if (picked.length !== wanted.size) throw invalidShift();
  return picked;
}

/** Níveis pedidos do alvo setor: o filtro (C5), os nomes do rótulo e os escolhidos (id e nome). */
export type PickedLevels = {
  filter: LevelFilter;
  names: string[];
  levels: { id: string; name: string }[];
};

/**
 * C5: só lê os níveis ativos com `levelIds`; inexistente ou inativo → 422
 * `invalid_level`. `levels` = os escolhidos na ordem dos ativos (painel da regra).
 */
export async function requireLevels(
  levels: Pick<LevelsRepository, 'listActive'>,
  target: Pick<SectorTargetInput, 'levelIds' | 'withoutLevel'>,
): Promise<PickedLevels> {
  const active = target.levelIds?.length ? await levels.listActive() : [];
  const picked = pickLevels(active, target);
  if (!picked) throw invalidLevel();
  const wanted = new Set(target.levelIds);
  return {
    ...picked,
    levels: active
      .filter((l) => wanted.has(l.id))
      .map(({ id, name }) => ({ id, name })),
  };
}
