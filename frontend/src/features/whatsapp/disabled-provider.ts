import type { ChannelProvider } from './api';

/**
 * Provedores ligados neste deploy (espelha `ENABLED_CHANNEL_PROVIDERS` do back).
 * Ligado ou desligado se decide só por aqui: nunca por comparação nova com
 * `'GOZAP'`, `'ZERNIO'` etc.
 */
export const ENABLED_PROVIDERS = ['EVOLUTION'] as const;

/** Não é type guard, de propósito: não quebra comparações antigas por estreitamento. */
export function isEnabledProvider(p: ChannelProvider): boolean {
  return (ENABLED_PROVIDERS as readonly ChannelProvider[]).includes(p);
}

/** Rótulo do provedor na UI (D10; espelha `PROVIDER_DISPLAY_NAME` do back). */
export const DISABLED_PROVIDER_LABEL: Readonly<Record<ChannelProvider, string>> = {
  GOZAP: 'GoZap',
  ZERNIO: 'Zernio',
  TWILIO: 'Twilio',
  META: 'Meta',
  EVOLUTION: 'Evolution',
};
