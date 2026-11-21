import {
  levelInactiveOnReactivation,
  sectorInactiveOnReactivation,
} from './users.errors';
import type { UsersRepository } from './users.repository';

type ReactivationRepo = Pick<
  UsersRepository,
  'findActiveSector' | 'findLevelForAssignment'
>;

/** Valor efetivo de um campo do vínculo: o informado, ou o atual quando ausente (E10). */
function effective(
  given: string | null | undefined,
  current: string | null,
): string | null {
  return given !== undefined ? given : current;
}

/**
 * Reativar (inativa → ativa) não pode deixar a pessoa num setor inativo nem num
 * nível desativado (E10, DJ13). Só vale na passagem de inativa para ativa: editar
 * quem já está ativa mantém o nível desativado que já é dele. O setor vem antes do
 * nível; trocar para um setor ou nível ativo na mesma gravação é aceito, e um setor
 * informado inativo já foi recusado antes com `user.sector_invalid`.
 */
export async function assertReactivationAllowed(
  repo: ReactivationRepo,
  user: { isActive: boolean; sectorId: string | null; levelId: string | null },
  input: {
    isActive?: boolean;
    sectorId?: string | null;
    levelId?: string | null;
  },
): Promise<void> {
  if (user.isActive || input.isActive !== true) return;
  const sectorId = effective(input.sectorId, user.sectorId);
  if (sectorId && !(await repo.findActiveSector(sectorId)))
    throw sectorInactiveOnReactivation();
  const levelId = effective(input.levelId, user.levelId);
  if (!levelId) return;
  const level = await repo.findLevelForAssignment(levelId);
  if (level && !level.isActive) throw levelInactiveOnReactivation();
}
