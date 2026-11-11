import type { TeamSectorChannel } from './schemas';

export type LiveState = TeamSectorChannel['live']['state'];
export type ChannelBlock = 'disconnected' | 'unverified';

/**
 * O que o estado ao vivo do número trava (D7). Só `open` libera o envio imediato. `unknown` = o
 * provedor não respondeu, então não se sabe: trava igual, mas com outro texto e com "Conferir de
 * novo". `connecting` conta como desconectado, como no servidor (`channel_disconnected`).
 */
export function liveBlock(state: LiveState): ChannelBlock | null {
  if (state === 'open') return null;
  return state === 'unknown' ? 'unverified' : 'disconnected';
}
