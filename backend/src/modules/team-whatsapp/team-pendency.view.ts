import type { Role } from '@prisma/client';
import type { TeamPendencyItem } from '../../schemas/contracts/team-pendency.schema';
import { nameView, phoneView } from '../../shared/authz/phone-visibility';
import type { HandlerStateView } from './team-actors.query';
import { factsOf, type AlertReplyMessage } from './team-alert.repository';
import {
  alertDeadlineAt,
  alertGroupOf,
  type AlertGroup,
} from './team-alert.rules';
import type { PendencyDetail } from './team-pendency.query';
import { pendencySituation, replyMediaOf } from './team-pendency.rules';
import { seesFullPhone } from './team-whatsapp.name-view';
import { canViewDispatch, type TeamActor } from './team-whatsapp.policy';

/**
 * Item da lista de pendências (K2-5, DK8), montado sem banco e sem relógio. A
 * regra de quem recebe o quê mora aqui: telefone pela chave
 * `telefone.ver_completo`, nome por `nameView`, `conversationId` só a quem tem
 * a caixa, `lastReply` só no grupo "Respondeu, sem ciência".
 */
export type PendencyViewContext = {
  actor: TeamActor;
  now: Date;
  /** Nome real de usuário por id (anotações e encerramento). */
  names: ReadonlyMap<string, string | null>;
  /** Mensagens de resposta lidas, por id (só as do grupo `replied`). */
  replies: ReadonlyMap<string, AlertReplyMessage>;
  /** Conversa da mensagem do envio, por id da mensagem. */
  conversations: ReadonlyMap<string, string | null>;
};

/** Caixa de entrada (K2-5, aceite 22): ADMIN e OPERATOR; o SUPERVISOR não abre conversa. */
const INBOX_ROLES: readonly Role[] = ['ADMIN', 'OPERATOR'];
export const seesInbox = (actor: TeamActor): boolean =>
  INBOX_ROLES.includes(actor.role);

/** Grupo do painel do alerta: as mesmas regras (`alertGroupOf(factsOf(row))`). */
export const groupOf = (d: PendencyDetail): AlertGroup =>
  alertGroupOf(factsOf(d));

const iso = (date: Date | null): string | null => date?.toISOString() ?? null;

/** O que a montagem vai ler do banco: só as respostas do grupo `replied`, as mensagens dos envios e os autores. */
export function viewNeedsOf(details: readonly PendencyDetail[]): {
  replyIds: string[];
  messageIds: string[];
  userIds: string[];
} {
  const replyIds: string[] = [];
  const messageIds: string[] = [];
  const userIds: string[] = [];
  for (const d of details) {
    if (d.lastReplyMessageId !== null && groupOf(d) === 'replied') {
      replyIds.push(d.lastReplyMessageId);
    }
    if (d.messageId !== null) messageIds.push(d.messageId);
    if (d.closedById !== null) userIds.push(d.closedById);
    for (const note of d.notes) userIds.push(note.authorId);
  }
  return { replyIds, messageIds, userIds };
}

function personView(
  d: PendencyDetail,
  full: boolean,
): TeamPendencyItem['person'] {
  return {
    name: nameView(d.userName, { full }),
    sectorId: d.sectorId,
    sectorName: d.sectorName,
    shiftName: d.shiftName,
    ...phoneView(d.phoneE164, { full }),
  };
}

function alertView(
  d: PendencyDetail,
  full: boolean,
): TeamPendencyItem['alert'] {
  const { alert } = d;
  return {
    text: alert.text,
    authorName: nameView(alert.authorName, { full }),
    sentAt: alert.createdAt.toISOString(),
    ackDeadlineAt: alertDeadlineAt(
      alert.createdAt,
      alert.ackDeadlineMinutes ?? 0,
    ).toISOString(),
  };
}

/** Nome vazio (usuário sem nome) vira `null`: a tela mostra o texto de nome ausente. */
function handlerView(
  d: PendencyDetail,
  handler: HandlerStateView | null,
  full: boolean,
): TeamPendencyItem['handler'] {
  if (d.handlerId === null) return null;
  const name = handler?.name ? handler.name : null;
  return {
    id: d.handlerId,
    name: nameView(name, { full }),
    state: handler?.state ?? 'inactive',
  };
}

function closureView(
  d: PendencyDetail,
  ctx: PendencyViewContext,
  full: boolean,
): TeamPendencyItem['closure'] {
  if (d.closedAt === null) return null;
  const byName =
    d.closedById === null ? null : (ctx.names.get(d.closedById) ?? null);
  return {
    byId: d.closedById,
    byName: nameView(byName, { full }),
    at: d.closedAt.toISOString(),
    reason: d.closeReason ?? '',
  };
}

function ackView(d: PendencyDetail): TeamPendencyItem['ack'] {
  if (d.ackAt === null) return null;
  return { kind: d.ackKind ?? 'KEYWORD', at: d.ackAt.toISOString() };
}

/** Só no grupo `replied`; mídia vira o tipo, sem legenda (Anti-objetivo 2). */
function lastReplyView(
  d: PendencyDetail,
  group: AlertGroup,
  replies: PendencyViewContext['replies'],
): TeamPendencyItem['lastReply'] {
  if (group !== 'replied' || d.lastReplyMessageId === null) return null;
  const message = replies.get(d.lastReplyMessageId);
  if (!message) return null;
  const media = replyMediaOf(message.kind);
  return {
    text: media === null ? message.content : null,
    media,
    at: message.at.toISOString(),
  };
}

function notesView(
  d: PendencyDetail,
  ctx: PendencyViewContext,
  full: boolean,
): TeamPendencyItem['notes'] {
  return d.notes.map((note) => ({
    id: note.id,
    kind: note.kind,
    authorName: nameView(ctx.names.get(note.authorId) ?? null, { full }),
    at: note.createdAt.toISOString(),
    text: note.text,
  }));
}

/** Só a quem abre a caixa e só quando o envio gerou mensagem (aceite 22). */
function conversationIdOf(
  d: PendencyDetail,
  ctx: PendencyViewContext,
): string | null {
  if (!seesInbox(ctx.actor) || d.messageId === null) return null;
  return ctx.conversations.get(d.messageId) ?? null;
}

export function buildPendencyItem(
  d: PendencyDetail,
  handler: HandlerStateView | null,
  ctx: PendencyViewContext,
): TeamPendencyItem {
  const full = seesFullPhone(ctx.actor);
  const group = groupOf(d);
  return {
    id: d.id,
    dispatchId: d.dispatchId,
    person: personView(d, full),
    alert: alertView(d, full),
    group,
    situation: pendencySituation(
      {
        ackAt: d.ackAt,
        closedAt: d.closedAt,
        handlerId: d.handlerId,
        handlerState: handler?.state ?? null,
        dueAt: d.dueAt,
      },
      ctx.now,
    ),
    handler: handlerView(d, handler, full),
    assignedAt: iso(d.assignedAt),
    dueAt: iso(d.dueAt),
    closure: closureView(d, ctx, full),
    ack: ackView(d),
    lastReply: lastReplyView(d, group, ctx.replies),
    notes: notesView(d, ctx, full),
    conversationId: conversationIdOf(d, ctx),
    canViewDispatch: canViewDispatch(ctx.actor, { authorId: d.alert.authorId }),
  };
}
