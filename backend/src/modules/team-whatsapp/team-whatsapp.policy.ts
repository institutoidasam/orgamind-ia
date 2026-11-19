import type { ChannelProvider, Role } from '@prisma/client';
import {
  ENABLED_CHANNEL_PROVIDERS,
  type EnabledChannelProvider,
} from '../../shared/config/enabled-providers';
import {
  hasPermission,
  type PermissionKey,
} from '../../shared/authz/permissions';

/**
 * Provedores que o envio da equipe aceita: os ligados (D1). Canal de provedor
 * desligado vira "sem número" em todo lugar que passa por `effectiveChannel`.
 */
export const TEAM_PROVIDERS = ENABLED_CHANNEL_PROVIDERS;
export type TeamProvider = EnabledChannelProvider;

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
  /** Pessoa sem acesso (GC5) nunca envia nem vê a escala, qualquer que seja o papel. */
  hasAccess: boolean;
  managedSectorIds: readonly string[];
  /** Permissões efetivas do papel, lidas do banco junto do ator (DB4). */
  permissions: readonly PermissionKey[];
};

/** O `sector` do alvo é checado aqui: não confiar só no filtro de `findActor`. */
export type TeamTargetUser = {
  isActive: boolean;
  sectorId: string | null;
  sector: { isActive: boolean } | null;
};

/** Papéis de escrita: VIEWER nunca envia, mesmo que ainda seja `managerId` de um setor. */
const SENDER_ROLES: readonly Role[] = ['ADMIN', 'SUPERVISOR', 'OPERATOR'];

/** ADMIN ativo com acesso, ou gestor ativo com acesso (de ≥1 setor ativo) e papel de escrita. */
export function isTeamSender(actor: TeamActor): boolean {
  if (!actor.isActive || !actor.hasAccess) return false;
  if (!SENDER_ROLES.includes(actor.role)) return false;
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

/**
 * Histórico e tela de resultado (GC5): o ADMIN vê todos os envios e os demais só
 * os próprios. Quem não vê trata o envio como inexistente (404, nunca 403); o
 * remetente é exigido antes, por `isTeamSender`.
 */
export function canViewDispatch(
  actor: TeamActor,
  dispatch: { authorId: string | null },
): boolean {
  return actor.role === 'ADMIN' || dispatch.authorId === actor.id;
}

/**
 * Disparo amplo (B4): o alvo cobre todos os setores ativos da organização e há
 * mais de um. Ids repetidos contam uma vez; setor inativo não entra em
 * `activeSectorIds`. Envio a uma pessoa nunca é amplo (alvo sem setores).
 */
export function isBroadSend(
  targetSectorIds: readonly string[],
  activeSectorIds: readonly string[],
): boolean {
  if (activeSectorIds.length <= 1) return false;
  const targeted = new Set(targetSectorIds);
  return activeSectorIds.every((id) => targeted.has(id));
}

/** A chave `equipe.disparo_amplo` decide, não o papel (a matriz inicial a dá a S e O). */
export function canBroadSend(actor: TeamActor): boolean {
  return hasPermission(actor, 'equipe.disparo_amplo');
}
