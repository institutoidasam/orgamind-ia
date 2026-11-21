import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../../shared/prisma/prisma.service';
import { pendencyNotFound } from './team-pendency.errors';
import {
  pendencyScopeOf,
  scopeAllows,
  type PendencyScope,
  type PendencyScopeFacts,
} from './team-pendency.rules';
import { findTeamActor } from './team-actor.query';
import { teamForbidden } from './team-whatsapp.errors';
import { isTeamSender, type TeamActor } from './team-whatsapp.policy';

/** Banco ou transação: a mesma leitura serve ao serviço e à transação da escrita (T6). */
export type PendencyDb = Pick<
  Prisma.TransactionClient,
  'teamWhatsappRecipient' | 'teamWhatsappDispatch' | 'user'
>;

export type PendencyFacts = PendencyScopeFacts & { dispatchId: string };

/** Só o envio com prazo de ciência é alerta (lembrete e outras finalidades têm `null`). */
function alertWhere(): Prisma.TeamWhatsappRecipientWhereInput {
  return { dispatch: { ackDeadlineMinutes: { not: null } } };
}

/**
 * Alcance (K2-4, DK3) no banco: a MESMA regra de `scopeAllows`, para a lista e o
 * contador filtrarem sem carregar o que o ator não vê. `null` = nenhuma
 * (`none`): o chamador devolve vazio sem consultar. Quem altera uma regra aqui
 * altera `scopeAllows` e roda o spec de equivalência.
 */
export function pendencyScopeWhere(
  scope: PendencyScope,
): Prisma.TeamWhatsappRecipientWhereInput | null {
  if (scope.kind === 'none') return null;
  if (scope.kind === 'all') return alertWhere();
  const sectorIds = [...scope.sectorIds];
  return {
    AND: [
      alertWhere(),
      {
        OR: [
          { dispatch: { authorId: scope.actorId } },
          { sectorId: { in: sectorIds } },
          // Envio nominal: sem setor gravado, vale o setor principal atual da pessoa.
          { sectorId: null, user: { sectorId: { in: sectorIds } } },
        ],
      },
    ],
  };
}

/** Fatos do alcance de uma pendência; `null` = o destinatário não existe. */
export async function findPendencyScopeFacts(
  db: PendencyDb,
  recipientId: string,
): Promise<PendencyFacts | null> {
  const row = await db.teamWhatsappRecipient.findUnique({
    where: { id: recipientId },
    select: {
      dispatchId: true,
      sectorId: true,
      user: { select: { sectorId: true } },
      dispatch: { select: { authorId: true, ackDeadlineMinutes: true } },
    },
  });
  if (row === null) return null;
  return {
    dispatchId: row.dispatchId,
    isAlert: row.dispatch.ackDeadlineMinutes !== null,
    authorId: row.dispatch.authorId,
    sectorId: row.sectorId,
    personSectorId: row.user?.sectorId ?? null,
  };
}

/**
 * Porta de toda rota de pendência (DK9): não remetente → 403 `forbidden`;
 * inexistente ou fora do alcance → 404 `pendency_not_found` (nunca 403, para
 * não revelar a existência). O ator é relido do banco a cada chamada (GK4).
 */
export async function requireVisiblePendency(
  prisma: PrismaService,
  actorId: string,
  recipientId: string,
): Promise<{ actor: TeamActor; facts: PendencyFacts }> {
  const actor = await findTeamActor(prisma, actorId);
  if (actor === null || !isTeamSender(actor)) throw teamForbidden();
  const facts = await findPendencyScopeFacts(prisma, recipientId);
  if (facts === null || !scopeAllows(pendencyScopeOf(actor), facts)) {
    throw pendencyNotFound();
  }
  return { actor, facts };
}
