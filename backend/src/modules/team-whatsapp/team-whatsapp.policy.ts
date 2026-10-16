import type { ChannelProvider, Role } from '@prisma/client';

/** Provedores não oficiais: aceitam texto livre fora de janela de sessão. */
export const TEAM_PROVIDERS = ['GOZAP', 'EVOLUTION'] as const;
export type TeamProvider = (typeof TEAM_PROVIDERS)[number];

export function isTeamProvider(
  provider: ChannelProvider,
): provider is TeamProvider {
  return (TEAM_PROVIDERS as readonly ChannelProvider[]).includes(provider);
}

/** `managedSectorIds` só traz setores ATIVOS em que o ator é `managerId`. */
export type TeamActor = {
  id: string;
  role: Role;
  isActive: boolean;
  managedSectorIds: readonly string[];
};

/** O `sector` do alvo é checado aqui: não confiar só no filtro de `findActor`. */
export type TeamTargetUser = {
  isActive: boolean;
  sectorId: string | null;
  sector: { isActive: boolean } | null;
};

/** Papéis de escrita: VIEWER nunca envia, mesmo que ainda seja `managerId` de um setor. */
const SENDER_ROLES: readonly Role[] = ['ADMIN', 'SUPERVISOR', 'OPERATOR'];

/** ADMIN ativo, ou gestor ativo (de ≥1 setor ativo) com papel de escrita. */
export function isTeamSender(actor: TeamActor): boolean {
  if (!actor.isActive || !SENDER_ROLES.includes(actor.role)) return false;
  return actor.role === 'ADMIN' || actor.managedSectorIds.length > 0;
}

export function canSendToSector(
  actor: TeamActor,
  sector: { id: string; isActive: boolean },
): boolean {
  if (!isTeamSender(actor) || !sector.isActive) return false;
  return actor.role === 'ADMIN' || actor.managedSectorIds.includes(sector.id);
}

export function canSendToUser(
  actor: TeamActor,
  target: TeamTargetUser,
): boolean {
  if (!isTeamSender(actor) || !target.isActive) return false;
  if (actor.role === 'ADMIN') return true;
  // O setor do ALVO tem de estar ativo: não confiar só no filtro de findActor.
  return (
    target.sectorId !== null &&
    target.sector?.isActive === true &&
    actor.managedSectorIds.includes(target.sectorId)
  );
}
