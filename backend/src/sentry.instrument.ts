// IMPORTANT: this file MUST be the very first import in the application
// entry points (`main.ts` and `worker.ts`) so Sentry can patch the runtime
// before NestJS / express / pg / ioredis etc. are loaded.
import * as Sentry from '@sentry/nestjs';
import { nodeProfilingIntegration } from '@sentry/profiling-node';

const dsn = process.env.SENTRY_DSN;

// Names of DomainError subclasses that represent expected business outcomes,
// not bugs. We never want these in Sentry — they would be pure noise and
// they're already returned to the client as RFC 9457 problem+json.
const DOMAIN_ERROR_NAMES = new Set<string>([
  'DomainError',
  'NotFoundError',
  'ConflictError',
  'UnauthorizedError',
  'ForbiddenError',
  'ValidationError',
  'WhatsappSendError',
  'WhatsappProviderNotConfiguredError',
  // Reserved for future DomainError subclasses; safe to list pre-emptively.
  'ContactNotFoundError',
  'CampaignNotFoundError',
  'TemplateNotFoundError',
  'CampaignAlreadyDispatchedError',
  'InvalidCredentialsError',
  'EmptyWorkbookError',
  'MetaCredentialsNotConfiguredError',
]);

/**
 * Review fix (round 2, achado autorizado fora do escopo original) — o
 * `requestDataIntegration` do SDK do Sentry anexa `request.url` e
 * `request.query_string` a TODO evento por padrão, mesmo sem aparecer na
 * lista explícita de `integrations` abaixo (o SDK inclui integrações padrão
 * automaticamente). `GET /contacts/export.xlsx?search=+5592995550101`
 * batendo num 4xx/5xx qualquer levaria o telefone para o Sentry por esta
 * porta — nenhuma das trocas de `req.url` → `req.path` em
 * `domain-exception.filter.ts` fecha isto, porque o Sentry monta `request`
 * a partir do `req` cru do Express, não do que o filtro loga.
 *
 * Função PURA (e não uma troca na lista de `integrations`) para garantir o
 * formato FINAL do evento, sem depender de detalhe de versão do SDK sobre
 * qual integração populou o quê. Reaproveitada por TRÊS hooks de
 * `Sentry.init` abaixo — `beforeSend` (eventos de erro), `beforeSendTransaction`
 * (eventos de transação) e, para a query em atributos de SPAN em vez de
 * `request`, `beforeSendSpan` chamando a irmã `scrubSpanQueryData` — porque
 * nenhum dos três roda por padrão para os outros tipos de evento (ver o
 * comentário de round 3 logo abaixo).
 */
export function scrubRequestQueryString<
  T extends { request?: { url?: string; query_string?: unknown } },
>(event: T): T {
  if (event.request?.query_string !== undefined) {
    delete event.request.query_string;
  }
  if (event.request?.url) {
    event.request.url = event.request.url.split('?')[0];
  }
  return event;
}

/**
 * Review fix (round 3) — `beforeSend` (abaixo) só roda para eventos de ERRO:
 * `@sentry/core`'s `processBeforeSend` testa `isErrorEvent(event) &&
 * beforeSend` antes de chamar (`node_modules/@sentry/core/build/cjs/client.js`,
 * função `isErrorEvent` = `event.type === undefined`; eventos de transação
 * têm `type: 'transaction'`). Com `tracesSampleRate: 0.1` em produção, uma
 * fração das transações É enviada, e o `requestDataIntegration` anexa
 * `request.query_string`/`request.url` a ELAS TAMBÉM — sem passar por
 * `scrubRequestQueryString`. `GET /contacts?search=+5592...` amostrado vira
 * telefone armazenado no Sentry mesmo sem erro nenhum.
 *
 * `TransactionEvent` estende a mesma `Event` (tem `request?: RequestEventData`,
 * `node_modules/@sentry/core/build/types/types/event.d.ts`) — não precisa de
 * função nova, só de passar `scrubRequestQueryString` para
 * `beforeSendTransaction` também.
 *
 * Spans (o root span da transação E cada span filho em `event.spans`)
 * carregam a query em atributos PRÓPRIOS, independentes de `request`, então
 * `scrubRequestQueryString` não os alcança — daí `scrubSpanQueryData` abaixo.
 * Nomes de atributo confirmados lendo o SDK instalado em
 * `backend/node_modules` (não documentação):
 *  - `url.query` (semconv novo, spans de servidor — `@opentelemetry/
 *    instrumentation-http/build/src/utils.js#getIncomingRequestAttributes`)
 *    e `http.query` (spans `http.client`/fetch — `@sentry/core/build/cjs/
 *    fetch.js#getFetchSpanAttributes` e `@sentry/node-core/.../
 *    outgoingFetchRequest.js`) guardam SÓ a query (com `?` incluso — é
 *    `URL.search` do Node, que já vem com o `?` líder) — sem parte de path
 *    que valha a pena manter, então são removidos por inteiro.
 *  - `url.full`, `http.url` (a URL inteira, com query) e `http.target`
 *    (semconv antigo, `pathname + search`) guardam path E query juntos —
 *    esses são cortados no primeiro `?`, preservando o path.
 *
 * Retorna SEMPRE o span (nunca `null`): o SDK trata um retorno falsy de
 * `beforeSendSpan` como "não pude processar" e empurra o span ORIGINAL,
 * não-filtrado, adiante (`client.js#processBeforeSend`) — "descartar" um
 * span não o remove, só devolve os dados crus sem scrub.
 */
const QUERY_ONLY_SPAN_ATTRIBUTES = ['url.query', 'http.query'] as const;
const QUERY_BEARING_SPAN_URL_ATTRIBUTES = [
  'url.full',
  'http.url',
  'http.target',
] as const;

export function scrubSpanQueryData<T extends { data?: Record<string, unknown> }>(
  span: T,
): T {
  const data = span.data;
  if (!data) return span;
  for (const attr of QUERY_ONLY_SPAN_ATTRIBUTES) {
    if (attr in data) delete data[attr];
  }
  for (const attr of QUERY_BEARING_SPAN_URL_ATTRIBUTES) {
    const value = data[attr];
    if (typeof value === 'string' && value.includes('?')) {
      data[attr] = value.split('?')[0];
    }
  }
  return span;
}

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV ?? 'development',
    release: process.env.GIT_SHA ?? 'unknown',
    integrations: [nodeProfilingIntegration()],
    tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,
    profilesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,
    beforeSend(event, hint) {
      // Don't send DomainError-family exceptions — they are expected
      // business outcomes (404/409/etc.), not unhandled bugs.
      const err = hint.originalException as
        | { name?: string; constructor?: { name?: string } }
        | undefined;
      const errName = err?.constructor?.name ?? err?.name ?? '';
      if (DOMAIN_ERROR_NAMES.has(errName)) {
        return null;
      }
      return scrubRequestQueryString(event);
    },
    beforeSendTransaction(event) {
      return scrubRequestQueryString(event);
    },
    beforeSendSpan(span) {
      return scrubSpanQueryData(span);
    },
  });
}
