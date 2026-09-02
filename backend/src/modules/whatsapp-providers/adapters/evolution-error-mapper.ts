/**
 * Maps low-level Evolution/Baileys/HTTP error strings to a stable error code
 * + a human-readable message in Portuguese. The point is: the provider returns
 * vague messages like "Connection Closed" or generic 4xx blobs, and the
 * operator opening the campaign detail page should immediately understand
 * what to do (e.g. "log out other Web sessions" vs "this number is invalid").
 */
export type EvolutionErrorCategory = {
  code: string;
  message: string;
  /** Whether reattempting will likely succeed (BullMQ should keep retrying) or not (mark FAILED now). */
  fatal: boolean;
};

/**
 * A single classification rule. `match` decides whether the (lowercased)
 * error text belongs to this category; `result` builds the category payload.
 *
 * Rules are evaluated top-to-bottom and the FIRST match wins — order is
 * significant because some substrings overlap (e.g. a "400" blob could also
 * mention "rate limit"; rate_limit/unauthorized must be tried before
 * bad_request so they win).
 */
type ClassificationRule = {
  match: (text: string) => boolean;
  result: (raw: unknown, rawString: string) => EvolutionErrorCategory;
};

/** Builds a predicate that is true when `text` includes ANY of the substrings. */
const includesAny =
  (...substrings: string[]) =>
  (text: string): boolean =>
    substrings.some((sub) => text.includes(sub));

/**
 * True when `code` appears as a standalone HTTP status number rather than as a
 * digit run inside a larger number. Recipient phone numbers / WhatsApp JIDs
 * (e.g. "5511994000123") and timestamps routinely embed "400"/"429" as internal
 * digit runs; requiring non-digit boundaries stops those from tripping the
 * bad_request / rate_limited rules and flipping a transient error to FAILED.
 */
const includesStatusCode =
  (code: string) =>
  (text: string): boolean =>
    new RegExp(`(^|\\D)${code}(\\D|$)`).test(text);

/** Closure reasons that mean the WhatsApp session is really gone and the operator must reconnect. */
const isPermanentClosure = includesAny(
  'conflict',
  'replaced',
  'logged out',
  'loggedout',
  'precondition required',
  'connection: close',
);

const RULES: ClassificationRule[] = [
  {
    // session_closed: the WA socket dropped, usually because another
    // WhatsApp Web/Desktop session replaced this one. Also covers the raw
    // WebSocket close codes the socket emits before a higher-level message
    // is generated: 1006 = abnormal closure, 1011 = server internal error.
    match: (text) =>
      includesAny(
        'connection closed',
        'conflict',
        'replaced',
        'precondition required',
        'connection: close',
        '"1006"',
        '"1011"',
      )(text) ||
      text === '1006' ||
      text === '["1006"]' ||
      text === '1011',
    result: (_raw, rawString) =>
      isPermanentClosure(rawString.toLowerCase())
        ? {
            code: 'evolution.session_closed',
            message:
              'Sessão WhatsApp desconectada. Outro WhatsApp Web/Desktop pode estar logado com esse número — saia de todos os "Aparelhos conectados" no app e reconecte em /connect.',
            fatal: true,
          }
        : {
            // Abnormal WS closures (1006/1011) and a plain "Connection Closed"
            // are almost always a brief socket drop (container restart, routine
            // reconnect). Retry them instead of permanently failing deliverable
            // messages; BullMQ's attempts ride out the blip.
            code: 'evolution.session_closed',
            message:
              'Conexão com o WhatsApp caiu momentaneamente. Tentando reenviar automaticamente; reconecte em /connect se persistir.',
            fatal: false,
          },
  },
  {
    // Baileys throws this when the underlying socket replies with an undefined
    // ack node — typically right after a reconnect, before the session settled.
    match: includesAny("cannot read properties of undefined (reading 'id')", 'cannot destructure property'),
    result: () => ({
      code: 'evolution.session_unstable',
      message:
        'Sessão WhatsApp ainda instabilizando. Aguarde 30 segundos após conectar antes de disparar, ou reconecte se persistir (verifique /connect).',
      fatal: false,
    }),
  },
  {
    match: includesAny('not connected', 'connection: connecting', 'instance not connected', 'not open'),
    result: () => ({
      code: 'evolution.not_connected',
      message: 'WhatsApp ainda não conectou. Acesse /connect e escaneie o QR Code antes de disparar.',
      fatal: false,
    }),
  },
  {
    match: includesAny('not on whatsapp', 'exists":false'),
    result: () => ({
      code: 'evolution.number_not_on_whatsapp',
      message: 'Número não está no WhatsApp.',
      fatal: true,
    }),
  },
  {
    match: (text) => includesAny('rate-overlimit', 'rate limit')(text) || includesStatusCode('429')(text),
    result: () => ({
      code: 'evolution.rate_limited',
      message: 'WhatsApp aplicou rate limit — aguarde e tente novamente.',
      fatal: false,
    }),
  },
  {
    // Evolution API auth failure (HTTP 401 "Unauthorized" for a wrong/rotated
    // AUTHENTICATION_API_KEY). This is a server-config problem, NOT a WhatsApp
    // ban — so it must be retryable, and it must be tried BEFORE the fatal
    // unauthorized/ban rule below so a bare 401 doesn't misfire as a ban.
    match: (text) => includesAny('unauthorized')(text) || includesStatusCode('401')(text),
    result: () => ({
      code: 'evolution.provider_unauthorized',
      message:
        'Falha de autenticação com a Evolution API (apikey inválida ou rotacionada?). Verifique a AUTHENTICATION_API_KEY do container — os envios serão retentados.',
      fatal: false,
    }),
  },
  {
    // WhatsApp-level rejection (possible spam flag / ban). Kept fatal.
    match: includesAny('not-authorized', 'forbidden', 'blocked'),
    result: () => ({
      code: 'evolution.unauthorized',
      message:
        'Ação rejeitada pelo WhatsApp. Pode indicar que o número foi marcado como spam ou banido — pare os disparos e investigue antes de continuar.',
      fatal: true,
    }),
  },
  {
    match: includesAny('timeout', 'etimedout', 'econnaborted'),
    result: () => ({
      code: 'evolution.timeout',
      message: 'Timeout ao falar com a Evolution API.',
      fatal: false,
    }),
  },
  {
    match: includesAny('econnrefused', 'enotfound'),
    result: () => ({
      code: 'evolution.unreachable',
      message: 'Evolution API inacessível (container fora? rede?).',
      fatal: false,
    }),
  },
  {
    // bad_request runs after rate_limit & unauthorized so those win when a
    // 4xx blob also mentions their keywords.
    match: (text) => text.includes('bad request') || includesStatusCode('400')(text),
    result: (raw) => ({
      code: 'evolution.bad_request',
      message: `Requisição inválida para a Evolution: ${raw ?? 'sem detalhes'}`,
      fatal: true,
    }),
  },
];

export function classifyEvolutionError(raw: unknown): EvolutionErrorCategory {
  // Evolution can return strings, arrays, or nested objects in `message`.
  // Coerce to a single string before matching, so a malformed payload
  // never crashes the worker and we still produce a useful classification.
  const rawString =
    typeof raw === 'string'
      ? raw
      : raw == null
        ? ''
        : (() => {
            try {
              return JSON.stringify(raw);
            } catch {
              return String(raw);
            }
          })();
  const text = rawString.toLowerCase();

  const rule = RULES.find((r) => r.match(text));
  if (rule) {
    return rule.result(raw, rawString);
  }

  return {
    code: 'evolution.unknown',
    message: rawString.trim().length > 0 ? rawString : 'Falha desconhecida no envio',
    fatal: false,
  };
}
