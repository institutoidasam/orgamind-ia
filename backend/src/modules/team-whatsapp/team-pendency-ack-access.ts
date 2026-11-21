import type { PrismaService } from '../../shared/prisma/prisma.service';
import { findPendencyScopeFacts } from './team-pendency-scope.repository';
import { pendencyScopeOf, scopeAllows } from './team-pendency.rules';
import { dispatchNotFound } from './team-whatsapp.errors';
import { canViewDispatch, type TeamActor } from './team-whatsapp.policy';
import type { TeamWhatsappRepository } from './team-whatsapp.repository';

type AckAccessDeps = {
  prisma: PrismaService;
  repo: Pick<TeamWhatsappRepository, 'findDispatchForActor'>;
};

/**
 * Visibilidade da ciência manual e do desfazer (K2-7, DK17): vê quem vê o envio
 * (`canViewDispatch`: ADMIN ou autor) OU tem a pendência no alcance K2-4 (gestor
 * do setor da pessoa). Quem não vê por nenhuma das duas recebe o MESMO 404 de
 * envio inexistente de antes (`dispatchNotFound`), indistinguível. O alcance
 * exige que a pessoa seja destinatária DESTE envio e que o envio seja alerta
 * (`scopeAllows`): quem não vê o envio nunca recebe 422 `not_an_alert`. O
 * remetente e a chave `equipe.urgencia` já foram checados por quem chama.
 */
export async function requireAckVisible(
  deps: AckAccessDeps,
  actor: TeamActor,
  ref: { dispatchId: string; recipientId: string },
): Promise<void> {
  const dispatch = await deps.repo.findDispatchForActor(ref.dispatchId);
  if (dispatch && canViewDispatch(actor, dispatch)) return;
  const facts = await findPendencyScopeFacts(deps.prisma, ref.recipientId);
  if (
    facts === null ||
    facts.dispatchId !== ref.dispatchId ||
    !scopeAllows(pendencyScopeOf(actor), facts)
  ) {
    throw dispatchNotFound();
  }
}
