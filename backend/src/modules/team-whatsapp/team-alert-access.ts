import { dispatchNotFound } from './team-whatsapp.errors';
import { canViewDispatch, type TeamActor } from './team-whatsapp.policy';
import type {
  DispatchForActor,
  TeamWhatsappRepository,
} from './team-whatsapp.repository';

/**
 * Visibilidade do alerta (GI5, C2): a mesma regra de `requireVisible` da tela de
 * resultado. ADMIN vê todos; os demais, só os próprios. Quem não vê recebe o
 * mesmo 404 de envio inexistente (nunca 403), para não descobrir que existe.
 * O remetente (`isTeamSender`, 403) é checado por quem chama, na ordem da rota.
 */
export async function requireViewable(
  repo: Pick<TeamWhatsappRepository, 'findDispatchForActor'>,
  actor: TeamActor,
  dispatchId: string,
): Promise<DispatchForActor> {
  const dispatch = await repo.findDispatchForActor(dispatchId);
  if (!dispatch || !canViewDispatch(actor, dispatch)) {
    throw dispatchNotFound();
  }
  return dispatch;
}
