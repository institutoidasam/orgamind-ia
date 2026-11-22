import type { ChannelProvider } from '@prisma/client';
import { isSessionProvider } from '../../schemas/contracts/channel-provider.schema';

/**
 * Fonte única de "provedor ligado". Só a Evolution está ligada; o código dos
 * outros provedores segue no repositório, inativo (GC5). Decidir ligado ou
 * desligado SEMPRE por `isEnabledChannelProvider` ou por esta lista — nunca
 * por comparação nova com `'GOZAP'`, `'ZERNIO'` etc.
 */
export const ENABLED_CHANNEL_PROVIDERS = [
  'EVOLUTION',
] as const satisfies readonly ChannelProvider[];

export type EnabledChannelProvider = (typeof ENABLED_CHANNEL_PROVIDERS)[number];

/**
 * NÃO é type guard, de propósito: um guard estreitaria `ChannelProvider` para
 * `'EVOLUTION'` e quebraria as comparações antigas (`=== 'ZERNIO'`) por
 * estreitamento de tipo.
 */
export function isEnabledChannelProvider(provider: ChannelProvider): boolean {
  return (ENABLED_CHANNEL_PROVIDERS as readonly ChannelProvider[]).includes(
    provider,
  );
}

/**
 * Canal de provedor desligado NÃO passa pelo gate de conexão: sem isso a
 * mensagem ficaria parada em WAITING_INSTANCE para sempre (a sessão do
 * provedor desligado nunca emite `open`). Provider que não é de sessão
 * também pula o gate, como antes.
 */
export function skipsConnectionGate(provider: ChannelProvider): boolean {
  return !isSessionProvider(provider) || !isEnabledChannelProvider(provider);
}

/** Nome de exibição (pt-BR) usado em mensagens ao usuário. */
export const PROVIDER_DISPLAY_NAME: Readonly<Record<ChannelProvider, string>> =
  {
    EVOLUTION: 'Evolution',
    GOZAP: 'GoZap',
    ZERNIO: 'Zernio',
    TWILIO: 'Twilio',
    META: 'Meta',
  };

/**
 * As 15 chaves de env que DEFINEM grupo dos provedores desligados, nesta
 * ordem. Chaves com default (ex.: `GOZAP_MAX_INSTANCES`) ficam de fora:
 * sempre teriam valor e o aviso nunca se calaria. ATENÇÃO: `ZERNIO_BASE_URL`
 * tem default no `envSchema`, então quem monta o aviso deve passar o env CRU
 * (`process.env`), não o `Env` já parseado — senão ela sempre aparece.
 */
export const DISABLED_PROVIDER_ENV_KEYS: readonly string[] = [
  'META_ACCESS_TOKEN',
  'META_PHONE_NUMBER_ID',
  'META_APP_SECRET',
  'META_WEBHOOK_VERIFY_TOKEN',
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_WHATSAPP_FROM',
  'TWILIO_MESSAGING_SERVICE_SID',
  'ZERNIO_API_KEY',
  'ZERNIO_BASE_URL',
  'ZERNIO_WEBHOOK_SECRET',
  'GOZAP_BASE_URL',
  'GOZAP_ADMIN_TOKEN',
  'GOZAP_WEBHOOK_TOKEN',
  'GOZAP_TOKEN_ENCRYPTION_KEY',
];

function hasValue(value: unknown): boolean {
  return typeof value === 'string' ? value.trim().length > 0 : value != null;
}

/** Chaves de provedores desligados com valor não vazio, na ordem fixa. */
export function ignoredProviderEnvKeys(
  env: Readonly<Record<string, unknown>>,
): string[] {
  return DISABLED_PROVIDER_ENV_KEYS.filter((key) => hasValue(env[key]));
}

/**
 * Texto do aviso de boot. SEGREDO: leva só os NOMES das chaves, nunca os
 * valores (GC6) — por isso recebe a lista de nomes, não o env.
 */
export function ignoredProviderEnvMessage(
  keys: readonly string[],
): string | null {
  if (keys.length === 0) return null;
  return `chaves de provedores desligados ignoradas: ${keys.join(', ')}`;
}
