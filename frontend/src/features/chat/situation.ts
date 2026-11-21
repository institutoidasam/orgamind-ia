import type { ConversationStatus, ConversationSummary } from './schemas';

/** Rótulos da situação da conversa (DK16). */
export const SITUATION_LABEL: Record<ConversationStatus, string> = {
  PENDING: 'Pendente',
  IN_PROGRESS: 'Em atendimento',
  RESOLVED: 'Resolvida',
};

export type Me = { id: string; role: string };

type SituationFields = { status?: string | null; resolvedAt?: string | null; assignedUserId?: string | null };

/**
 * Situação da conversa: a que o servidor mandou; sem `status` (contrato
 * antigo) ou com um valor desconhecido, calcula pelos campos como o back
 * (resolvida > com atendente > pendente).
 */
export function situationOf(c: SituationFields): ConversationStatus {
  if (c.status && Object.hasOwn(SITUATION_LABEL, c.status)) return c.status as ConversationStatus;
  if (c.resolvedAt) return 'RESOLVED';
  return c.assignedUserId ? 'IN_PROGRESS' : 'PENDING';
}

/** "{nome}" ou "{nome} (inativo)" (K1-8); null sem nome. */
export function assigneeLabel(name: string | null | undefined, active: boolean | null | undefined): string | null {
  if (!name) return null;
  return active === false ? `${name} (inativo)` : name;
}

export type ConversationActions = {
  resolve: boolean;
  reopen: boolean;
  assume: boolean;
  transfer: boolean;
  remove: boolean;
};

/**
 * Botões da conversa por situação e papel (DK16). Só esconde o que não cabe:
 * a decisão de autorização é do servidor (403 `chat.not_assignee`).
 */
export function conversationActions(c: ConversationSummary, me: Me): ConversationActions {
  const situation = situationOf(c);
  const admin = me.role === 'ADMIN';
  if (situation === 'RESOLVED') {
    return { resolve: false, reopen: true, assume: true, transfer: true, remove: false };
  }
  if (situation === 'PENDING') {
    return { resolve: admin, reopen: false, assume: true, transfer: true, remove: false };
  }
  const mine = c.assignedUserId === me.id;
  return { resolve: mine || admin, reopen: false, assume: !mine, transfer: mine || admin, remove: mine || admin };
}

/**
 * Compositor travado (DK17): conversa aberta com atendente que não é quem olha.
 * Pendente, minha e resolvida deixam responder (a resposta assume). O travamento
 * por 409 `chat.assigned_to_other` é estado local do compositor.
 */
export function replyLock(c: ConversationSummary, meId: string): { locked: boolean; name: string | null } {
  const locked = situationOf(c) === 'IN_PROGRESS' && !!c.assignedUserId && c.assignedUserId !== meId;
  return { locked, name: locked ? assigneeLabel(c.assignedUserName, c.assignedUserActive) : null };
}
