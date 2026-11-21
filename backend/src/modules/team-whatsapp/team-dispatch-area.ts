import { teamForbidden } from './team-whatsapp.errors';
import {
  canSendToSector,
  canSendToUser,
  type TeamActor,
} from './team-whatsapp.policy';
import type {
  DispatchForActor,
  TeamWhatsappRepository,
} from './team-whatsapp.repository';

/** O que a checagem de área lê do repositório (o "Repetir" e o lembrete a injetam). */
export type DispatchAreaRepo = Pick<
  TeamWhatsappRepository,
  'findTargetUser' | 'findSector'
>;

/**
 * Mesma regra do cancelamento para envio a setor: ADMIN qualquer; o gestor só
 * se TODO setor do envio passa por `canSendToSector` (envio a setor sem linha
 * de setor → 403: "todos" de uma lista vazia não autoriza). Alvo pessoa: o
 * `canSendToUser` do `targetId` vale para todos (ADMIN inclusive), e usuário
 * apagado ou inativo → 403, porque o envio reentregaria a quem já saiu.
 * Extraída do "Repetir" (Lote I, CI10) sem mudar o corpo; o lembrete a reutiliza.
 */
export async function requireAreaOf(
  repo: DispatchAreaRepo,
  actor: TeamActor,
  dispatch: DispatchForActor,
): Promise<void> {
  if (dispatch.targetType === 'USER') {
    const user = await repo.findTargetUser(dispatch.targetId);
    if (!user || !canSendToUser(actor, user)) throw teamForbidden();
    return;
  }
  if (actor.role === 'ADMIN') return;
  if (dispatch.sectors.length === 0) throw teamForbidden();
  for (const { sectorId } of dispatch.sectors) {
    const sector = await repo.findSector(sectorId);
    if (!sector || !canSendToSector(actor, sector)) throw teamForbidden();
  }
}
