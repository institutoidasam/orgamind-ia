import type { PendencyHandoverSkipReason } from '../../schemas/contracts/team-pendency.schema';
import { hasPermission } from '../../shared/authz/permissions';
import type { PendencyConflict } from './team-pendency.rules';
import { isTeamSender, type TeamActor } from './team-whatsapp.policy';

/**
 * Regras puras da passagem de pendências da equipe (Lote K3, CT3). Nada aqui lê
 * banco: o serviço relê os atores e passa os fatos.
 */

/**
 * K3-4: passa as pendências de quem sai o próprio responsável ou o ADMIN. Nega
 * → 403 `team_whatsapp.not_handler`. O alcance de quem pede é conferido à parte
 * (K2-4), item a item.
 */
export function canHandoverPendenciesFrom(
  actor: { id: string; role: string },
  fromId: string,
): boolean {
  return fromId === actor.id || actor.role === 'ADMIN';
}

/**
 * K3-4/K2-7: destino do pedido inteiro. Ativo, com acesso, remetente
 * (`isTeamSender`), com `equipe.enviar` e diferente de quem sai; senão o
 * pedido todo é 404, como usuário inexistente. Se o destino vê cada pendência
 * (K2-4) é conferido item a item.
 */
export function isPendencyHandoverTarget(
  dest: TeamActor | null,
  fromId: string,
): boolean {
  if (dest === null || dest.id === fromId) return false;
  return isTeamSender(dest) && hasPermission(dest, 'equipe.enviar');
}

/**
 * DT4.4: motivo do pulo quando a gravação condicional devolve conflito.
 * `currentHandlerId` é o responsável que a linha travada tem agora: se já é o
 * destino, repetir o pedido é inofensivo (`already_with_target`). `not_closed`
 * só nasce de expectativa `closed: true` (reabrir); a passagem espera
 * `closed: false`, então é inalcançável e cai no pulo que não grava nada,
 * como `missing`.
 */
export function handoverSkipOf(
  conflict: PendencyConflict,
  currentHandlerId: string | null | undefined,
  toId: string,
): PendencyHandoverSkipReason {
  switch (conflict) {
    case 'acked':
      return 'acked';
    case 'closed':
      return 'closed';
    case 'handler_changed':
      return currentHandlerId === toId
        ? 'already_with_target'
        : 'other_handler';
    case 'missing':
    case 'not_closed':
      return 'not_found';
  }
}
