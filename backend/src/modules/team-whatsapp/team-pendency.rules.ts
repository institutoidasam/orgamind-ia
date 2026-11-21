import type { MessageKind } from '@prisma/client';
import { hasPermission } from '../../shared/authz/permissions';
import type {
  HandlerState,
  PendencySituation,
} from '../../schemas/contracts/team-pendency.schema';
import { isTeamSender, type TeamActor } from './team-whatsapp.policy';

/**
 * Regras puras das pendências da equipe (Lote K2, CK4). Nada aqui lê banco nem
 * depende dos tipos das colunas novas: as regras recebem fatos próprios.
 */

/** Prazo da tratativa (K2-8): constante única do sistema. */
export const PENDENCY_HANDLING_MINUTES = 60;
/** Teto de linhas lidas pela lista antes de paginar (DK7). */
export const PENDENCY_LIST_MAX_ROWS = 2000;

/** Fim do prazo de uma tratativa que começa (ou recomeça) em `now`. */
export function pendencyDueAt(now: Date): Date {
  return new Date(now.getTime() + PENDENCY_HANDLING_MINUTES * 60_000);
}

/** Alcance de quem olha (K2-4, DK3): a única regra de quem vê cada pendência. */
export type PendencyScope =
  | { kind: 'none' }
  | { kind: 'all' }
  | { kind: 'limited'; actorId: string; sectorIds: readonly string[] };

export function pendencyScopeOf(actor: TeamActor | null): PendencyScope {
  if (actor === null || !isTeamSender(actor)) return { kind: 'none' };
  if (actor.role === 'ADMIN') return { kind: 'all' };
  return {
    kind: 'limited',
    actorId: actor.id,
    sectorIds: actor.managedSectorIds,
  };
}

/**
 * Fatos de uma pendência para o alcance: `isAlert` = o envio tem prazo de
 * ciência (lembrete e outras finalidades não têm); `sectorId` é o gravado no
 * destinatário na hora do envio; `personSectorId` é o setor principal atual.
 */
export type PendencyScopeFacts = {
  isAlert: boolean;
  authorId: string | null;
  sectorId: string | null;
  personSectorId: string | null;
};

/** Setor efetivo: o gravado no envio; vazio (envio nominal), o atual da pessoa. */
export function effectiveSectorId(f: PendencyScopeFacts): string | null {
  return f.sectorId ?? f.personSectorId;
}

/**
 * Setor sem gestor (K2-9) sai sozinho: ninguém o tem em `sectorIds`, então só o
 * ADMIN e o autor do alerta veem.
 */
export function scopeAllows(
  scope: PendencyScope,
  f: PendencyScopeFacts,
): boolean {
  if (scope.kind === 'none' || !f.isAlert) return false;
  if (scope.kind === 'all') return true;
  if (f.authorId !== null && f.authorId === scope.actorId) return true;
  const sectorId = effectiveSectorId(f);
  return sectorId !== null && scope.sectorIds.includes(sectorId);
}

/**
 * Quem pode tratar a pendência (assumir, receber transferência, K3-4): é
 * remetente, tem `equipe.enviar` e a vê pelo alcance. Também a regra do destino
 * de "Transferir" e da lista de destinos.
 */
export function canHandlePendency(
  actor: TeamActor | null,
  f: PendencyScopeFacts,
): boolean {
  return (
    actor !== null &&
    isTeamSender(actor) &&
    hasPermission(actor, 'equipe.enviar') &&
    scopeAllows(pendencyScopeOf(actor), f)
  );
}

/**
 * Responsável válido (K2-2, DK4): `inactive` = inexistente, inativo ou sem
 * acesso; `out_of_scope` = deixou de poder tratar a pendência; senão `active`.
 */
export function handlerStateOf(
  handler: TeamActor | null,
  f: PendencyScopeFacts,
): HandlerState {
  if (handler === null || !handler.isActive || !handler.hasAccess) {
    return 'inactive';
  }
  return canHandlePendency(handler, f) ? 'active' : 'out_of_scope';
}

export type PendencyStateFacts = {
  ackAt: Date | null;
  closedAt: Date | null;
  handlerId: string | null;
  handlerState: HandlerState | null;
  dueAt: Date | null;
};

/** Situação calculada (K2-2, DK5): ciente > encerrada > sem responsável > atrasada > em tratativa. */
export function pendencySituation(
  f: PendencyStateFacts,
  now: Date,
): PendencySituation {
  if (f.ackAt !== null) return 'ACKED';
  if (f.closedAt !== null) return 'CLOSED';
  if (f.handlerId === null || f.handlerState !== 'active') return 'UNASSIGNED';
  if (f.dueAt !== null && f.dueAt.getTime() <= now.getTime()) return 'OVERDUE';
  return 'IN_PROGRESS';
}

/** `ackDeadlineAt` = `alertDeadlineAt(createdAt, ackDeadlineMinutes)` do alerta. */
export type SortablePendency = {
  id: string;
  situation: PendencySituation;
  alertCreatedAt: Date;
  ackDeadlineAt: Date;
};

/** Contador (K2-6): sem responsável e com o prazo de ciência já vencido. */
export function isUnassignedOverdue(p: SortablePendency, now: Date): boolean {
  return (
    p.situation === 'UNASSIGNED' && p.ackDeadlineAt.getTime() <= now.getTime()
  );
}

/** Posto 0 = sem responsável vencida; 1 = atrasada; 2 = as demais (K2-5). */
function rankOf(p: SortablePendency, now: Date): number {
  if (isUnassignedOverdue(p, now)) return 0;
  return p.situation === 'OVERDUE' ? 1 : 2;
}

/** Ordem da lista (K2-5): posto, alerta mais antigo primeiro, depois `id`. */
export function comparePendencies(
  a: SortablePendency,
  b: SortablePendency,
  now: Date,
): number {
  const rank = rankOf(a, now) - rankOf(b, now);
  if (rank !== 0) return rank;
  const age = a.alertCreatedAt.getTime() - b.alertCreatedAt.getTime();
  if (age !== 0) return age;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

type ReplyMedia = 'audio' | 'image' | 'file' | null;

const REPLY_MEDIA: Readonly<Record<MessageKind, ReplyMedia>> = {
  TEXT: null,
  AUDIO: 'audio',
  IMAGE: 'image',
  STICKER: 'image',
  VIDEO: 'file',
  DOCUMENT: 'file',
  LOCATION: 'file',
  CONTACT: 'file',
  UNSUPPORTED: 'file',
};

/** Tipo de mídia da última resposta (DK8); texto é `null` e mostra o próprio texto. */
export function replyMediaOf(kind: MessageKind): ReplyMedia {
  return REPLY_MEDIA[kind];
}

/** Colunas da pendência lidas sob a trava da linha (DK10). */
export type LockedPendency = {
  id: string;
  dispatchId: string;
  ackAt: Date | null;
  handlerId: string | null;
  assignedAt: Date | null;
  dueAt: Date | null;
  closedAt: Date | null;
  closedById: string | null;
  closeReason: string | null;
};

/**
 * O que a tela mostrava. `closed: 'any'` = não olha o encerramento;
 * `ignoreAck` = não olha a ciência. Só Registrar contato usa os dois (DK13).
 */
export type PendencyExpectation = {
  handlerId: string | null;
  closed: boolean | 'any';
  ignoreAck?: boolean;
};

export type PendencyConflict =
  'missing' | 'acked' | 'closed' | 'not_closed' | 'handler_changed';

/** Conferência sob trava (DK10.3), nesta ordem; `null` = a linha ainda é a que a tela mostrava. */
export function pendencyConflict(
  locked: LockedPendency,
  expect: PendencyExpectation,
): Exclude<PendencyConflict, 'missing'> | null {
  if (locked.ackAt !== null && expect.ignoreAck !== true) return 'acked';
  const isClosed = locked.closedAt !== null;
  if (expect.closed === false && isClosed) return 'closed';
  if (expect.closed === true && !isClosed) return 'not_closed';
  if (locked.handlerId !== expect.handlerId) return 'handler_changed';
  return null;
}

export type AssumeKind = 'assume' | 'take_over' | 'noop';

/**
 * Tipo do "Assumir" (DK11): eu já sou o responsável = `noop`; responsável
 * ativo de outra pessoa = `take_over` ("Assumir de outro"); sem responsável,
 * ou com um inativo ou fora do alcance = `assume`.
 */
export function assumeKind(
  actorId: string,
  expectedHandlerId: string | null,
  expectedState: HandlerState | null,
): AssumeKind {
  if (expectedHandlerId === actorId) return 'noop';
  if (expectedHandlerId !== null && expectedState === 'active') {
    return 'take_over';
  }
  return 'assume';
}

/** `true` = 403 `not_handler` (DK12–DK14): só o ADMIN age sem ser o responsável mostrado. */
export function requiresHandler(
  actor: { id: string; role: string },
  expectedHandlerId: string | null,
): boolean {
  return actor.role !== 'ADMIN' && expectedHandlerId !== actor.id;
}
