import type { TeamChannel } from './schemas';

export type ChannelAvailability =
  | { usable: true }
  | { usable: false; label: 'Desconectado' | 'Aguardando conexão' };

const WAITING: ChannelAvailability = { usable: false, label: 'Aguardando conexão' };

/**
 * Situação do canal para o seletor de envio. `connectionState` nulo (evento de
 * conexão expirado ou nunca recebido) NUNCA significa desconectado: com
 * telefone conhecido o canal segue utilizável; sem telefone ainda não pareou.
 */
export function channelAvailability(
  { connectionState, phoneE164 }: Pick<TeamChannel, 'connectionState' | 'phoneE164'>,
): ChannelAvailability {
  if (connectionState === 'open') return { usable: true };
  if (connectionState === 'close') return { usable: false, label: 'Desconectado' };
  if (connectionState === 'connecting') return WAITING;
  return phoneE164 ? { usable: true } : WAITING;
}
