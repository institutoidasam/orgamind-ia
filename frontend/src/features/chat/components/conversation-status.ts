import type { AssigneeFilter } from './assignee-tabs';

/** Situação pedida à lista (K1-10): Abertas = Pendente + Em atendimento. */
export type ConversationStatusFilterValue = 'open' | 'resolved';

/**
 * "Resolvidas" não tem atendente: a aba de atendente (cuja escolha fica salva)
 * só vale, e só vai na consulta, em "Abertas".
 */
export function assigneeForStatus(
  status: ConversationStatusFilterValue,
  assignee: AssigneeFilter,
): 'me' | 'unassigned' | undefined {
  return status === 'open' ? (assignee ?? undefined) : undefined;
}
