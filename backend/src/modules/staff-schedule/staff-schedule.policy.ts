import {
  canSendToSector,
  isTeamSender,
  type TeamActor,
} from '../team-whatsapp/team-whatsapp.policy';

/**
 * Política da escala (GC8), funções puras. Ver segue a de envio: ADMIN e gestor
 * (`isTeamSender`), só nos setores que alcança. Editar depende do setor
 * PRINCIPAL da pessoa: o gestor do destino de "Outro setor" vê o visitante, mas
 * não o edita. `managedSectorIds` já vem só com setores ativos (findTeamActor).
 */
export function canViewSchedule(actor: TeamActor): boolean {
  return isTeamSender(actor);
}

/** Setores cujo quadro o ator vê; null = todos os ativos (ADMIN); [] = nenhum. */
export function viewableSectorIds(actor: TeamActor): readonly string[] | null {
  if (!canViewSchedule(actor)) return [];
  return actor.role === 'ADMIN' ? null : actor.managedSectorIds;
}

export function canEditPerson(
  actor: TeamActor,
  person: { sectorId: string | null },
): boolean {
  if (!canViewSchedule(actor)) return false;
  if (actor.role === 'ADMIN') return true;
  return (
    person.sectorId !== null && actor.managedSectorIds.includes(person.sectorId)
  );
}

/** Destino de "Outro setor": ADMIN, qualquer ativo; gestor, só um que também gerencia. */
export function canAssignSector(
  actor: TeamActor,
  sector: { id: string; isActive: boolean },
): boolean {
  return canSendToSector(actor, sector);
}
