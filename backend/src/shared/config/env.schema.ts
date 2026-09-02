import { z } from 'zod';

// ── Provider credential groups ──────────────────────────────────────────────
// A WhatsApp provider is usable only when its ENTIRE credential group is set.
// The compose forwards unset vars as `${VAR:-}` = '' (empty string), so an empty
// value counts as ABSENT. Rules (validated in superRefine + mirrored at runtime
// by the ProviderRegistry via `configuredProviderGroups`):
//   - a group is "present" if ANY of its member vars is non-empty;
//   - a present group must be COMPLETE (all required members set) or boot fails;
//   - at least one group must be complete or boot fails.

export type ProviderGroupName =
  'meta' | 'evolution' | 'twilio' | 'zernio' | 'gozap';

type EnvInput = Record<string, unknown>;

/** A var counts as set only when it is a non-empty (trimmed) string. */
function isSet(v: unknown): boolean {
  return typeof v === 'string' ? v.trim().length > 0 : v != null;
}

export type GroupState = {
  /** at least one member var is set */
  present: boolean;
  /** required members still missing (empty when the group is complete) */
  missing: string[];
};

const META_KEYS = [
  'META_ACCESS_TOKEN',
  'META_PHONE_NUMBER_ID',
  'META_APP_SECRET',
  'META_WEBHOOK_VERIFY_TOKEN',
] as const;

const EVOLUTION_KEYS = [
  'EVOLUTION_BASE_URL',
  'EVOLUTION_API_KEY',
  'EVOLUTION_INSTANCE_NAME',
] as const;

// ZERNIO_BASE_URL is intentionally NOT in this list: it carries a schema
// default (see envSchema below), so it is always "set" once parsed — if it
// counted towards presence, every deploy would look like it has the Zernio
// group present and would be forced to also set API_KEY + WEBHOOK_SECRET or
// fail boot, even on deploys that never touch Zernio.
const ZERNIO_KEYS = ['ZERNIO_API_KEY', 'ZERNIO_WEBHOOK_SECRET'] as const;

// Unlike ZERNIO_BASE_URL, GOZAP_BASE_URL DOES count towards presence: the
// GoZap base URL has no possible schema default (it's a per-tenant
// subdomain), so there is no value it could silently fall back to — it is
// simply required, same as the other three GOZAP_* vars.
const GOZAP_KEYS = [
  'GOZAP_BASE_URL',
  'GOZAP_ADMIN_TOKEN',
  'GOZAP_WEBHOOK_TOKEN',
  'GOZAP_TOKEN_ENCRYPTION_KEY',
] as const;

function simpleGroupState(env: EnvInput, keys: readonly string[]): GroupState {
  const present = keys.some((k) => isSet(env[k]));
  const missing = present ? keys.filter((k) => !isSet(env[k])) : [];
  return { present, missing };
}

export function metaGroupState(env: EnvInput): GroupState {
  return simpleGroupState(env, META_KEYS);
}

export function evolutionGroupState(env: EnvInput): GroupState {
  return simpleGroupState(env, EVOLUTION_KEYS);
}

/**
 * Zernio needs API_KEY + WEBHOOK_SECRET. BASE_URL is excluded (see the
 * ZERNIO_KEYS comment above) — it has a schema default and is never part of
 * the presence/completeness check.
 */
export function zernioGroupState(env: EnvInput): GroupState {
  return simpleGroupState(env, ZERNIO_KEYS);
}

/**
 * GoZap needs all four vars together (BASE_URL + ADMIN_TOKEN + WEBHOOK_TOKEN
 * + TOKEN_ENCRYPTION_KEY) — unlike Zernio, BASE_URL has no default (see the
 * GOZAP_KEYS comment above), so it is part of the presence/completeness
 * check like the other three.
 */
export function gozapGroupState(env: EnvInput): GroupState {
  return simpleGroupState(env, GOZAP_KEYS);
}

/**
 * Twilio needs ACCOUNT_SID + AUTH_TOKEN + (WHATSAPP_FROM or MESSAGING_SERVICE_SID).
 * The sender is an either/or, so it can't use the simple all-of helper.
 */
export function twilioGroupState(env: EnvInput): GroupState {
  const sid = isSet(env.TWILIO_ACCOUNT_SID);
  const token = isSet(env.TWILIO_AUTH_TOKEN);
  const from = isSet(env.TWILIO_WHATSAPP_FROM);
  const msgSid = isSet(env.TWILIO_MESSAGING_SERVICE_SID);
  const present = sid || token || from || msgSid;
  if (!present) return { present: false, missing: [] };
  const missing: string[] = [];
  if (!sid) missing.push('TWILIO_ACCOUNT_SID');
  if (!token) missing.push('TWILIO_AUTH_TOKEN');
  if (!from && !msgSid) missing.push('TWILIO_WHATSAPP_FROM');
  return { present, missing };
}

function isComplete(s: GroupState): boolean {
  return s.present && s.missing.length === 0;
}

const PROVIDER_GROUPS: Array<
  [ProviderGroupName, (env: EnvInput) => GroupState]
> = [
  ['meta', metaGroupState],
  ['evolution', evolutionGroupState],
  ['twilio', twilioGroupState],
  ['zernio', zernioGroupState],
  ['gozap', gozapGroupState],
];

/**
 * Which provider groups are FULLY configured for the given env. The runtime
 * ProviderRegistry uses this (via ConfigService) to decide which adapters to
 * register, so it stays in lock-step with the boot-time superRefine below.
 */
export function configuredProviderGroups(env: EnvInput): ProviderGroupName[] {
  return PROVIDER_GROUPS.filter(([, state]) => isComplete(state(env))).map(
    ([name]) => name,
  );
}

export const envSchema = z
  .object({
    NODE_ENV: z
      .enum(['development', 'production', 'test'])
      .default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
      .default('info'),

    DATABASE_URL: z.string().url(),
    REDIS_HOST: z.string().default('redis'),
    REDIS_PORT: z.coerce.number().int().positive().default(6379),
    WORKER_HEALTH_PORT: z.coerce.number().int().positive().default(3001),
    MEDIA_DIR: z.string().default('/data/media'),

    JWT_SECRET: z.string().min(32),
    JWT_ACCESS_EXPIRES_IN: z.string().default('15m'),
    JWT_REFRESH_EXPIRES_IN: z.string().default('7d'),

    // C1 — sal do phoneHash (sha256(E164 + sal)) que chaveia ConsentEvent e
    // SuppressionList. ATENÇÃO: trocar este valor ORFANIZA toda a supressão e
    // todo o histórico de consentimento já gravado (os hashes deixam de casar)
    // — na prática, ressuscita quem deu PARAR. Definir uma vez, por ambiente,
    // e nunca mais mexer. O default só existe para dev/teste.
    PICOA_CONSENT_SALT: z.string().default('orgamind-consent-dev'),

    // Worker tuning (worker process restart required to apply)
    WORKER_CONCURRENCY: z.coerce.number().int().positive().default(10),
    WORKER_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(80),
    WORKER_RATE_LIMIT_DURATION_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(1000),

    META_PHONE_NUMBER_ID: z.string().optional(),
    META_BUSINESS_ACCOUNT_ID: z.string().optional(),
    META_ACCESS_TOKEN: z.string().optional(),
    META_APP_SECRET: z.string().optional(),
    META_WEBHOOK_VERIFY_TOKEN: z.string().optional(),

    // Multi-provider: a Twilio/Meta-only deploy may forward `${EVOLUTION_BASE_URL:-}`
    // = '' from the compose. A bare `.url()` would reject that empty default and
    // crash boot, so map '' → undefined first (same pattern as DIFY_BASE_URL).
    EVOLUTION_BASE_URL: z
      .preprocess(
        (v) => (v === '' ? undefined : v),
        z.string().url().optional(),
      )
      .optional(),
    EVOLUTION_API_KEY: z.string().optional(),
    EVOLUTION_INSTANCE_NAME: z.string().optional(),
    // Where Evolution should POST events (MESSAGES_UPDATE acks, etc).
    // Defaults to the Docker-internal `http://api:3000/webhooks/whatsapp`.
    EVOLUTION_WEBHOOK_URL: z.string().url().optional(),

    // Outbound proxy for Evolution's Baileys WhatsApp socket. WhatsApp flags the
    // VPS datacenter IP on the unofficial route, so the socket must egress via a
    // residential/mobile IP. The proxy lives on the Evolution INSTANCE (stored in
    // Evolution's Postgres), not on orgamind — but declaring it here lets the adapter
    // re-arm it every time it touches the instance, so a `restart()` (which
    // deletes + recreates the instance) or a fresh environment can never silently
    // drop it. Enabled only when host + port + protocol are all present.
    // The compose forwards `${VAR:-}` (empty string) when unset, so every field
    // must tolerate '' — the adapter treats empty as absent.
    EVOLUTION_PROXY_HOST: z.string().optional(),
    EVOLUTION_PROXY_PORT: z.string().optional(),
    // z.enum would reject the compose's empty-string default and crash boot,
    // so map '' → undefined first (same pattern as DIFY_BASE_URL below).
    EVOLUTION_PROXY_PROTOCOL: z
      .preprocess(
        (v) => (v === '' ? undefined : v),
        z.enum(['http', 'https', 'socks4', 'socks5']).optional(),
      )
      .optional(),
    EVOLUTION_PROXY_USERNAME: z.string().optional(),
    EVOLUTION_PROXY_PASSWORD: z.string().optional(),

    // Twilio WhatsApp Business API (official provider). Required only when the
    // full Twilio credential group is set (enforced in the superRefine below).
    TWILIO_ACCOUNT_SID: z.string().optional(),
    TWILIO_AUTH_TOKEN: z.string().optional(),
    // The WhatsApp-enabled sender, e.g. `whatsapp:+14155238886` (Sandbox) or a
    // provisioned number. The adapter normalises to exactly one `whatsapp:` prefix.
    TWILIO_WHATSAPP_FROM: z.string().optional(),
    // Optional Messaging Service SID — sent instead of `From` when configured.
    TWILIO_MESSAGING_SERVICE_SID: z.string().optional(),
    // The EXACT public callback URL configured in Twilio ("when a message comes
    // in" + status callback), e.g. https://picoa.app.br/api/webhooks/twilio.
    // Twilio signs this exact URL; the app is behind a proxy that strips `/api`
    // and terminates TLS, so it can't reconstruct the signed URL from the
    // request — validate against this configured value instead.
    // The compose forwards `${TWILIO_WEBHOOK_URL:-}` (empty string) when unset,
    // so this must accept `''` — a `.url()` here would reject the empty default
    // and crash boot. Kept plain-optional like the sibling TWILIO_* vars; the
    // controller treats an empty value as absent and validates shape at use.
    TWILIO_WEBHOOK_URL: z.string().optional(),
    // Content API host override (tests/dev fake server only). Production
    // leaves it unset and TwilioContentService talks to the real
    // https://content.twilio.com.
    TWILIO_CONTENT_BASE_URL: z.string().optional(),
    // Senders API v2 host override (tests/dev fake server only). Production
    // leaves it unset and TwilioSendersService talks to the real
    // https://messaging.twilio.com.
    TWILIO_SENDERS_BASE_URL: z.string().optional(),

    // Zernio Cloud API (official provider). Required only when the full
    // Zernio credential group is set (API_KEY + WEBHOOK_SECRET — enforced in
    // the superRefine below). BASE_URL is NOT part of that group (see the
    // ZERNIO_KEYS comment above) — it defaults so a deploy never has to set
    // it just to reach a completeness check.
    ZERNIO_API_KEY: z.string().optional(),
    // The compose forwards `${ZERNIO_BASE_URL:-}` (empty string) when unset,
    // so '' must resolve to the default instead of failing `.url()` — same
    // preprocess-empty-to-undefined pattern as DIFY_BASE_URL/EVOLUTION_BASE_URL.
    ZERNIO_BASE_URL: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z.string().url().default('https://zernio.com/api/v1'),
    ),
    ZERNIO_WEBHOOK_SECRET: z.string().optional(),

    // GoZap Cloud API (5º provider — WhatsApp não-oficial via QR, SaaS
    // hospedado por terceiros). Required only when the full GOZAP credential
    // group is set (BASE_URL + ADMIN_TOKEN + WEBHOOK_TOKEN +
    // TOKEN_ENCRYPTION_KEY — enforced in the superRefine below). Unlike
    // ZERNIO_BASE_URL, GOZAP_BASE_URL has NO default: the subdomain is
    // per-tenant, so there is nothing sane to fall back to.
    //
    // The preprocess is NOT optional here: docker-compose.prod.yml forwards
    // `GOZAP_BASE_URL: ${GOZAP_BASE_URL:-}`, i.e. delivers an EMPTY STRING
    // when the env isn't set — and `.url()` on an empty string crashes boot.
    // Same preprocess EVOLUTION_BASE_URL already uses; follow it verbatim.
    GOZAP_BASE_URL: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z.string().url().optional(),
    ),
    GOZAP_ADMIN_TOKEN: z.string().optional(),
    GOZAP_WEBHOOK_TOKEN: z.string().optional(),
    // Interruptor de FIM da transição do achado C20 ("o segredo do webhook em
    // texto claro no access log"). O receptor aceita o segredo por cabeçalho
    // (`X-Webhook-Token` / `Authorization: Bearer`) E, por compatibilidade, na
    // query (`?t=`) — porque a URL com o segredo está gravada no painel do
    // GoZap, que é SaaS de terceiro: recusar a query antes de reconfigurar o
    // painel derruba TODA a entrada (ack, mensagem recebida, opt-out).
    //
    // Depois de reconfigurar o painel e rotacionar o segredo, ponha `false`
    // aqui: a query deixa de autenticar e o segredo some das URLs para sempre.
    // Ver OPERATIONS.md → "Webhook do GoZap: tirar o segredo da URL".
    //
    // O DEFAULT É `true` de propósito: um deploy que não conhece esta var não
    // pode perder eventos por causa dela. E o desligamento tem lista fechada,
    // pelo mesmo motivo de GOZAP_WEBHOOK_DEBUG — só que invertido, e com o
    // cuidado extra da string VAZIA, que é o que docker-compose entrega
    // (`${VAR:-}`) quando a env não está definida: '' tem de significar
    // "não configurado" = ligado, nunca "desligado".
    //
    // A lista de desligamento é comparada em caixa baixa e sem espaço nas
    // pontas: quem digita isto é uma PESSOA, num campo de texto do painel do
    // Dokploy, e `FALSE`, `False` e `false ` (espaço colado) são o que de fato
    // acontece. Se qualquer um deles continuasse valendo "ligado", o operador
    // cumpriria o passo final da migração, veria o deploy verde e acreditaria
    // ter fechado a porta — sem erro de boot, sem log, sem nada que o
    // contradissesse. O fail-open segue intacto: string vazia, só espaços e
    // valor ausente continuam significando LIGADO.
    GOZAP_WEBHOOK_ALLOW_QUERY_TOKEN: z
      .preprocess((v) => {
        if (typeof v === 'boolean') return v;
        const s = String(v).trim().toLowerCase();
        return !(s === '0' || s === 'false' || s === 'no' || s === 'off');
      }, z.boolean())
      .default(true),
    // AES-256-GCM key for the instance token at rest: exactly 32 bytes, hex
    // encoded (64 hex chars). A malformed key must fail BOOT, not the first
    // send — that is why this is a strict regex instead of a bare string.
    // Same empty-string trap as GOZAP_BASE_URL: the compose forwards
    // `${GOZAP_TOKEN_ENCRYPTION_KEY:-}` (='') on every deploy that doesn't
    // set it, and a bare regex would reject '' and crash boot — so '' must
    // be preprocessed to undefined before the regex ever sees it.
    GOZAP_TOKEN_ENCRYPTION_KEY: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z
        .string()
        .regex(/^[0-9a-fA-F]{64}$/)
        .optional(),
    ),
    // Optional: captures raw inbound webhook payloads for shape validation
    // (GoZap's webhook contract is undocumented — see gozap-cloud.adapter.ts).
    // Never required for the group to be considered configured.
    //
    // NÃO usar `z.coerce.boolean()`: ele é `Boolean(v)`, então TODA string
    // não-vazia vira `true` — inclusive `"false"`, `"0"` e `"no"`. Um operador
    // que "desliga" o debug digitando `false` no painel estaria, na verdade,
    // LIGANDO o despejo do payload cru (telefone + texto do eleitor) no log.
    // Lista fechada de valores ligados; qualquer outra coisa é desligado.
    GOZAP_WEBHOOK_DEBUG: z
      .preprocess((v) => v === true || v === '1' || v === 'true', z.boolean())
      .default(false),

    // Ritmo da VALIDAÇÃO ATIVA de números pelo GoZap (`/chat/check`), em
    // consultas por minuto. 40 é lento de propósito: consulta de existência em
    // massa por número NÃO-OFICIAL é um sinal conhecido de bloqueio, e o
    // número deste cliente já foi banido antes. Subir isto aumenta o risco de
    // perder o canal — o risco está escrito na tela, e o padrão é conservador.
    //
    // O `preprocess` de string vazia NÃO é decorativo: o compose entrega
    // `${GOZAP_CHECK_RATE_PER_MIN:-}` como STRING VAZIA (não como ausente), e
    // `.default(40)` do zod só vale para `undefined`. Sem ele,
    // `z.coerce.number()` sobre `''` dá 0, `.positive()` reprova e o BOOT CAI
    // — o mesmo tropeço já documentado em ORG_PRIVACY_POLICY_URL.
    GOZAP_CHECK_RATE_PER_MIN: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z.coerce.number().int().positive().default(40),
    ),

    // ★ VALIDAÇÃO AUTOMÁTICA DIÁRIA — DESLIGADA POR PADRÃO.
    //
    // O cron `whatsapp.contact-sync.cron` seleciona a base inteira (até 5000
    // por noite) e a manda para o `/chat/check`. Antes da Fase B isso era um
    // no-op em produção por acidente: o processor voltava cedo sem canal
    // EVOLUTION, e produção só tem GoZap. Com a validação passando a funcionar
    // por canal de SESSÃO, o mesmo cron viraria uma VARREDURA EM MASSA não
    // vigiada — e consulta de existência em massa por cliente NÃO OFICIAL é
    // sinal conhecido de bloqueio (este cliente já perdeu um número).
    //
    // A decisão de produto (spec B.5) é que a validação ativa é EXPLÍCITA: o
    // operador clica em "Validar não validados (N)" DEPOIS de ler o aviso de
    // risco. Ligar isto aqui só com decisão explícita de quem responde pelo
    // número — e, ligado, o cron corre no ritmo de `GOZAP_CHECK_RATE_PER_MIN`,
    // dentro da janela de envio do canal.
    //
    // Mesmo preprocess de `GOZAP_WEBHOOK_DEBUG` e pelo mesmo motivo: NÃO usar
    // `z.coerce.boolean()` (= `Boolean(v)`), que transforma a string `"false"`
    // em `true` — quem "desligasse" o cron digitando `false` no painel estaria
    // LIGANDO a varredura. Lista fechada de valores ligados.
    CONTACT_SYNC_CRON_ENABLED: z
      .preprocess((v) => v === true || v === '1' || v === 'true', z.boolean())
      .default(false),

    // ── Identidade da organização titular deste deploy ──────────────────────
    // O orgamind é single-tenant POR INSTALAÇÃO (um deploy por cliente). O que
    // estas vars alimentam vai para o TITULAR DOS DADOS: o texto de
    // consentimento, a landing pública /opt-in e o texto do wa.me/QR. A Meta
    // exige que o texto nomeie o negócio e a LGPD exige controlador determinado
    // (art. 8º) — um titular do cliente A autorizando "a organização B" produz
    // um consentimento inválido.
    //
    // São OPCIONAIS de propósito: o boot de um deploy existente não pode quebrar
    // por falta delas. Sem env, o fallback é NEUTRO ("Organização") — jamais o
    // nome de outro cliente. Semeiam `Organization` (singleton); a partir daí a
    // tela de Configurações é a fonte da verdade e o seed não a sobrescreve.
    ORG_NAME: z.string().optional(),
    ORG_LEGAL_NAME: z.string().optional(),
    // `.url()` rejeitaria o `${ORG_PRIVACY_POLICY_URL:-}` = '' do compose e
    // derrubaria o boot — mesmo preprocess dos demais opcionais.
    ORG_PRIVACY_POLICY_URL: z
      .preprocess(
        (v) => (v === '' ? undefined : v),
        z.string().url().optional(),
      )
      .optional(),
    ORG_SUPPORT_CONTACT: z.string().optional(),

    APP_BASE_URL: z.string().url(),
    // ATENÇÃO: interna POR PROJETO — é o endereço que os containers do MESMO
    // compose usam para chamar a api (`http://api:3000`). NÃO serve para
    // provedor SaaS externo; para esse caso existe PUBLIC_WEBHOOK_BASE_URL.
    WEBHOOK_BASE_URL: z.string().url(),
    // A base PÚBLICA do receptor de webhooks — a que um provedor de terceiro
    // (GoZap) precisa conseguir chamar pela internet. Inclui o prefixo do
    // proxy: o nginx do `web` faz `location /api/ → proxy_pass http://api:3000/`
    // (tira o `/api`), então o valor certo é `https://SEU-DOMINIO/api`, igual
    // ao TWILIO_WEBHOOK_URL que já roda em produção.
    // Opcional: um deploy só-Evolution/Meta não precisa dela. O `'' →
    // undefined` é obrigatório porque o compose encaminha `${VAR:-}` e um
    // `.url()` cru rejeitaria a string vazia e derrubaria o boot.
    PUBLIC_WEBHOOK_BASE_URL: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z.string().url().optional(),
    ),
    // Comma-separated list of allowed origins. An empty/whitespace value or a
    // non-URL entry silently breaks CORS in confusing ways, so validate every
    // entry up front and fail fast at boot.
    CORS_ORIGIN: z
      .string()
      .trim()
      .min(1, 'CORS_ORIGIN must not be empty')
      .refine(
        (val) =>
          val
            .split(',')
            .map((o) => o.trim())
            .filter((o) => o.length > 0)
            .every((o) => {
              try {
                new URL(o);
                return true;
              } catch {
                return false;
              }
            }),
        'CORS_ORIGIN must be a comma-separated list of valid URLs',
      ),

    // Bull Board (HTTP basic auth)
    BULL_BOARD_USER: z.string().default('admin'),
    BULL_BOARD_PASSWORD: z.string().min(8).default('changeme123'),

    // Sentry (optional). Without SENTRY_DSN the SDK does not initialise.
    SENTRY_DSN: z.string().url().optional(),
    // Dify (auto-resposta conversacional). Opcional: sem bots configurados, o
    // recurso fica inerte. Inclui o sufixo /v1, ex.: https://dify.host/v1.
    // A chave da OpenAI vive DENTRO do Dify; o orgamind nunca a guarda.
    // preprocess: o compose passa `DIFY_BASE_URL: ${DIFY_BASE_URL:-}`, que vira
    // string vazia ("") quando não setado. `.optional()` só cobre `undefined`,
    // então "" cairia no `.url()` e quebraria o boot. Tratar "" como ausente.
    DIFY_BASE_URL: z
      .preprocess(
        (v) => (v === '' ? undefined : v),
        z.string().url().optional(),
      )
      .optional(),
    // Dify Console API (lista apps + chaves). Opcional: sem isso, a listagem
    // direta fica inerte. URL inclui o sufixo /console/api.
    DIFY_CONSOLE_URL: z
      .preprocess(
        (v) => (v === '' ? undefined : v),
        z.string().url().optional(),
      )
      .optional(),
    DIFY_CONSOLE_EMAIL: z
      .preprocess((v) => (v === '' ? undefined : v), z.string().optional())
      .optional(),
    DIFY_CONSOLE_PASSWORD: z
      .preprocess((v) => (v === '' ? undefined : v), z.string().optional())
      .optional(),
    GIT_SHA: z.string().optional(),
  })
  // Provider credentials are validated by GROUP — there is no single
  // deploy-global "the provider" selector: any non-empty var in a group makes
  // the WHOLE group required, and at least one group must be fully
  // configured. This lets one deploy serve several providers at once
  // (multi-provider channels) while still failing fast on a half-configured
  // group instead of surfacing `Bearer undefined` at first send.
  .superRefine((env, ctx) => {
    let anyComplete = false;
    for (const [name, state] of PROVIDER_GROUPS) {
      const s = state(env);
      if (s.present && s.missing.length > 0) {
        for (const key of s.missing) {
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: `Required — the ${name} provider group is partially configured (set all of its variables or none)`,
          });
        }
      }
      if (isComplete(s)) anyComplete = true;
    }
    if (!anyComplete) {
      // No single field owns this failure (it's a cross-group invariant), so
      // the issue is attached to a synthetic path rather than a real env var.
      ctx.addIssue({
        code: 'custom',
        path: ['providers'],
        message:
          'At least one WhatsApp provider group must be fully configured (meta, evolution, twilio, zernio, or gozap)',
      });
    }

    // The Bull Board password ships with a placeholder dev default so local
    // boots work out of the box. In production that placeholder (and an empty
    // value) must never be accepted — fail fast at boot instead of exposing the
    // queue dashboard behind a guessable credential.
    if (env.NODE_ENV === 'production') {
      if (
        !env.BULL_BOARD_PASSWORD ||
        env.BULL_BOARD_PASSWORD === 'changeme123'
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['BULL_BOARD_PASSWORD'],
          message:
            'Must be set to a real (non-placeholder) value when NODE_ENV=production',
        });
      }
    }
  });

export type Env = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(config);
  if (!parsed.success) {
    const errors = parsed.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment variables:\n${errors}`);
  }
  return parsed.data;
}
