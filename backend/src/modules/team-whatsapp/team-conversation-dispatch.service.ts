import { Injectable } from '@nestjs/common';
import type { TeamDispatchPurpose } from '@prisma/client';
import type {
  ConversationLastDispatch,
  PendencySituation,
} from '../../schemas/contracts/team-pendency.schema';
import { NotFoundError } from '../../shared/errors/domain.error';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { findTeamActor } from './team-actor.query';
import { handlerStatesFor } from './team-actors.query';
import { findPendencyScopeFacts } from './team-pendency-scope.repository';
import {
  pendencyScopeOf,
  pendencySituation,
  scopeAllows,
} from './team-pendency.rules';
import {
  canViewDispatch,
  isTeamSender,
  type TeamActor,
} from './team-whatsapp.policy';
import { fromDbPurpose } from './team-whatsapp.purpose-codes';

type LastRow = {
  recipientId: string;
  parentRecipientId: string | null;
  dispatchId: string;
  authorId: string | null;
  purpose: TeamDispatchPurpose | null;
  isAlert: boolean;
  parentDispatchId: string | null;
  parentAuthorId: string | null;
  sentAt: Date;
};

/**
 * Última linha de destinatário cuja mensagem é desta conversa (a de mensagem mais
 * nova). Entra pela conversa (`m."conversationId"`, `@@index([messageId])` do
 * destinatário). A data é a do disparo (`firedAt`; o envio agendado nasce antes de
 * sair), como a etiqueta por mensagem (DT6). Só colunas de identificação, finalidade
 * e data: nenhum texto do envio sai daqui.
 */
async function findLastRow(
  prisma: PrismaService,
  conversationId: string,
): Promise<LastRow | null> {
  const rows = await prisma.$queryRaw<LastRow[]>`
    SELECT r."id" AS "recipientId", r."parentRecipientId",
           d."id" AS "dispatchId", d."authorId",
           d."purpose"::text AS "purpose",
           (d."ackDeadlineMinutes" IS NOT NULL) AS "isAlert",
           d."parentDispatchId", p."authorId" AS "parentAuthorId",
           COALESCE(d."firedAt", d."createdAt") AS "sentAt"
    FROM "TeamWhatsappRecipient" r
    JOIN "Message" m ON m."id" = r."messageId"
    JOIN "TeamWhatsappDispatch" d ON d."id" = r."dispatchId"
    LEFT JOIN "TeamWhatsappDispatch" p ON p."id" = d."parentDispatchId"
    WHERE m."conversationId" = ${conversationId}
    ORDER BY m."createdAt" DESC, m."id" DESC, r."id" DESC
    LIMIT 1`;
  return rows[0] ?? null;
}

/**
 * Alerta de referência (DT7): o pai, se o último é lembrete (e a pendência é a
 * linha apontada por `parentRecipientId`, nunca a de `userId`); senão o próprio
 * envio, sendo alerta; senão nenhum alerta (o link ainda é do envio).
 */
function referenceOf(row: LastRow): {
  dispatchId: string;
  authorId: string | null;
  alertRecipientId: string | null;
} {
  if (row.parentDispatchId !== null) {
    return {
      dispatchId: row.parentDispatchId,
      authorId: row.parentAuthorId,
      alertRecipientId: row.parentRecipientId,
    };
  }
  return {
    dispatchId: row.dispatchId,
    authorId: row.authorId,
    alertRecipientId: row.isAlert ? row.recipientId : null,
  };
}

/**
 * Situação da pendência só no alcance de quem olha (K2-4): a MESMA regra do K2
 * (`pendencyScopeOf` + `scopeAllows`); quem não é remetente cai em `none` e nem
 * lê a linha. Fora do alcance, nada (nunca revela a existência).
 */
async function pendencyOf(
  prisma: PrismaService,
  actor: TeamActor | null,
  recipientId: string | null,
  now: Date,
): Promise<{ situation: PendencySituation } | null> {
  const scope = pendencyScopeOf(actor);
  if (recipientId === null || scope.kind === 'none') return null;
  const facts = await findPendencyScopeFacts(prisma, recipientId);
  if (facts === null || !scopeAllows(scope, facts)) return null;
  const state = await prisma.teamWhatsappRecipient.findUnique({
    where: { id: recipientId },
    select: {
      ackAt: true,
      pendencyClosedAt: true,
      pendencyHandlerId: true,
      pendencyDueAt: true,
    },
  });
  if (state === null) return null;
  const [handler] = await handlerStatesFor(prisma, [
    { ...facts, handlerId: state.pendencyHandlerId },
  ]);
  const situation = pendencySituation(
    {
      ackAt: state.ackAt,
      closedAt: state.pendencyClosedAt,
      handlerId: state.pendencyHandlerId,
      handlerState: handler?.state ?? null,
      dueAt: state.pendencyDueAt,
    },
    now,
  );
  return { situation };
}

/**
 * "Último envio à equipe nesta conversa" (K3-6, DT7). Finalidade e data são de
 * quem tem a caixa; o `dispatchId` ("Ver resultado") só de quem vê o envio
 * (`isTeamSender` + `canViewDispatch`, o mesmo critério da tela de resultado) e
 * a situação só de quem tem a pendência no alcance. Ator relido do banco (GK4).
 * Leitura: não grava trilha nem evento.
 */
@Injectable()
export class TeamConversationDispatchService {
  constructor(private readonly prisma: PrismaService) {}

  async lastDispatch(
    actorId: string,
    conversationId: string,
    now: Date,
  ): Promise<ConversationLastDispatch> {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { id: true },
    });
    if (conversation === null) {
      throw new NotFoundError('Conversation', conversationId);
    }
    const row = await findLastRow(this.prisma, conversationId);
    if (row === null) return { last: null };
    const actor = await findTeamActor(this.prisma, actorId);
    const ref = referenceOf(row);
    const canView =
      actor !== null &&
      isTeamSender(actor) &&
      canViewDispatch(actor, { authorId: ref.authorId });
    return {
      last: {
        purpose: fromDbPurpose(row.purpose),
        sentAt: row.sentAt.toISOString(),
        isReminder: row.parentDispatchId !== null,
        dispatchId: canView ? ref.dispatchId : null,
        pendency: await pendencyOf(
          this.prisma,
          actor,
          ref.alertRecipientId,
          now,
        ),
      },
    };
  }
}
