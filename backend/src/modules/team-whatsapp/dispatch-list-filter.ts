import { addDays, zonedStart } from '../staff-schedule/civil-date';
import type { DispatchListQuery } from './dto/dispatch-list-query.dto';
import type { DispatchListFilter } from './team-whatsapp.repository';
import { toDbPurpose } from './team-whatsapp.purpose-codes';

/**
 * DG14: filtros da lista do histórico em instantes. `from`/`to` são dias civis
 * de Manaus sobre `createdAt`, inclusive: `from` vira a meia-noite do dia e
 * `to` a meia-noite do dia seguinte (exclusiva). Sem nenhum filtro → undefined
 * (a lista de hoje). O autor nunca entra aqui: quem soma "só os próprios" é o
 * repositório, sobre este filtro.
 */
export function dispatchListFilter(
  query: DispatchListQuery,
): DispatchListFilter | undefined {
  const { from, to, purpose, state } = query;
  if (!from && !to && !purpose && !state) return undefined;
  return {
    createdFrom: from ? zonedStart(from, '00:00') : undefined,
    createdBefore: to ? zonedStart(addDays(to, 1), '00:00') : undefined,
    purpose: purpose ? toDbPurpose(purpose) : undefined,
    state,
  };
}
