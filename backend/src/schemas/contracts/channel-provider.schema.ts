import { z } from 'zod';

/**
 * Mirrors the Prisma `ChannelProvider` enum (UPPERCASE values). Single source
 * for the contract-layer provider enum — instance.schema.ts and
 * template.schema.ts both re-export this instead of each declaring their own
 * (identically-shaped) copy, which used to risk silent drift if only one was
 * updated when a provider was added/removed.
 */
export const channelProviderEnum = z.enum([
  'EVOLUTION',
  'TWILIO',
  'ZERNIO',
  'META',
  'GOZAP',
]);
export type ChannelProviderContract = z.infer<typeof channelProviderEnum>;

/**
 * Traits de POLÍTICA por provider — fatos declarados, não deriváveis do código.
 *
 * - `official`: envia pela API oficial da Meta (direto ou via BSP) e está sob a
 *   WhatsApp Business Messaging Policy — opt-in é condição contratual. O gate
 *   da LGPD vale para TODOS, oficial ou não.
 * - `sessionBased`: sessão WhatsApp pareada (QR/Baileys-like) que pode cair —
 *   liga o gate de conexão do router, o pipeline anti-ban e o guard do bot.
 * - `sessionWindow`: texto livre sujeito à janela de 24h da Meta (regra técnica
 *   da Cloud API; ver chat/session-window.ts, que deriva daqui).
 *
 * Um provider novo é OBRIGADO a declarar os três — `Record` sobre o enum torna
 * a omissão um erro de compilação, o oposto do esquecível `if (=== 'EVOLUTION')`.
 */
export type ProviderTraits = {
  official: boolean;
  sessionBased: boolean;
  sessionWindow: boolean;
};

/**
 * Congelado em runtime (`Object.freeze`) e readonly em compile-time: virou fonte
 * ÚNICA de um gate de compliance (o override de consentimento), e um objeto
 * exportado mutável permitiria a qualquer módulo — ou a qualquer teste que
 * esqueça de restaurar — alargar esse gate para o processo inteiro.
 *
 * A anotação `Record<ChannelProviderContract, ...>` continua sendo o que torna a
 * omissão de um provider novo um erro de compilação.
 */
export const PROVIDER_TRAITS: Readonly<
  Record<ChannelProviderContract, Readonly<ProviderTraits>>
> = Object.freeze({
  EVOLUTION: Object.freeze({ official: false, sessionBased: true, sessionWindow: false }),
  TWILIO: Object.freeze({ official: true, sessionBased: false, sessionWindow: true }),
  ZERNIO: Object.freeze({ official: true, sessionBased: false, sessionWindow: true }),
  META: Object.freeze({ official: true, sessionBased: false, sessionWindow: false }),
  GOZAP: Object.freeze({ official: false, sessionBased: true, sessionWindow: false }),
});

function traitsOf(provider: string | null | undefined): ProviderTraits | undefined {
  if (provider == null) return undefined;
  return (PROVIDER_TRAITS as Record<string, ProviderTraits>)[provider];
}

/**
 * Provedores OFICIAIS — DERIVADA dos traits (antes era uma allowlist manual
 * duplicada no frontend).
 *
 * ATENÇÃO ao default: um provider desconhecido/mal declarado cai em
 * `official: false`, e isso tem DOIS efeitos OPOSTOS — não é um fail-safe:
 *
 *  - no gate de opt-in CONTRATUAL (Messaging Policy do BSP), "não-oficial"
 *    significa que a exigência do BSP não se aplica: uma restrição a menos,
 *    inofensivo — o gate da LGPD continua valendo para todos;
 *  - no OVERRIDE DE CONSENTIMENTO (campaign-consent-gate + campaigns.service),
 *    "não-oficial" é exatamente a condição que PERMITE disparar sem
 *    consentimento. Ali o default abre o gate, não fecha.
 *
 * Por isso o override não pode depender só deste predicado sem uma decisão
 * humana registrada por provider — ver o teste-tripwire em
 * channel-provider.schema.spec.ts, que quebra de propósito quando um provider
 * não-oficial novo entra no mapa.
 */
export const OFFICIAL_PROVIDERS = channelProviderEnum.options.filter(
  (p) => PROVIDER_TRAITS[p].official,
);

export function isOfficialProvider(
  provider: string | null | undefined,
): boolean {
  return traitsOf(provider)?.official ?? false;
}

/** Provider de sessão (QR/pareamento, conexão pode cair). */
export function isSessionProvider(
  provider: string | null | undefined,
): boolean {
  return traitsOf(provider)?.sessionBased ?? false;
}

/** Provider cujo texto livre está sujeito à janela de 24h da Meta. */
export function hasMetaSessionWindow(
  provider: string | null | undefined,
): boolean {
  return traitsOf(provider)?.sessionWindow ?? false;
}
