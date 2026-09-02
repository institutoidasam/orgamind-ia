import type { ProviderTraits } from '../../../schemas/contracts/channel-provider.schema';

export type ProviderCapability =
  | 'campaignSend'
  | 'statusPolling'
  | 'sessionLifecycle'
  | 'inboxChat'
  | 'chatMedia'
  | 'contactTools'
  | 'labels'
  | 'historySync';

export type ProviderProfile = {
  traits: ProviderTraits;
  capabilities: ReadonlySet<ProviderCapability>;
};

/**
 * O objeto devolvido é congelado (`Object.freeze`) — ninguém troca o `traits`
 * nem o `capabilities` de um adapter já construído em runtime.
 *
 * O que NÃO é garantido: o CONTEÚDO do Set. `ReadonlySet` é só compile-time e
 * `Object.freeze` não alcança os slots internos de um Set, então `.add()` num
 * cast continua funcionando. Se um dia isso importar, a correção é trocar a
 * estrutura, não pendurar mais um freeze aqui.
 */
export function makeProfile(
  traits: ProviderTraits,
  caps: ProviderCapability[],
): ProviderProfile {
  return Object.freeze({ traits, capabilities: new Set(caps) });
}

export function supports(
  holder: { profile: ProviderProfile },
  cap: ProviderCapability,
): boolean {
  return holder.profile.capabilities.has(cap);
}
