import { describe, it, expect } from 'vitest';
import { scrubRequestQueryString, scrubSpanQueryData } from './sentry.instrument';

/**
 * Review fix (round 2, achado autorizado fora do escopo original) —
 * `GET /contacts/export.xlsx?search=+5592995550101` batendo num 4xx/5xx
 * qualquer levaria o telefone para o Sentry via `request.query_string`
 * (anexado pelo `requestDataIntegration` padrão do SDK, mesmo sem aparecer
 * na lista explícita de `integrations`). Este é um teste PURO da função de
 * scrub usada em `beforeSend` — não sobe o SDK de verdade.
 */
describe('scrubRequestQueryString — a query string nunca chega ao Sentry', () => {
  it('remove request.query_string e corta a query de request.url', () => {
    const event = {
      request: {
        url: 'https://picoa.example/contacts/export.xlsx?search=%2B5592995550101',
        query_string: 'search=%2B5592995550101',
      },
    };

    const scrubbed = scrubRequestQueryString(event);

    expect(scrubbed.request?.query_string).toBeUndefined();
    expect(scrubbed.request?.url).toBe(
      'https://picoa.example/contacts/export.xlsx',
    );
    expect(JSON.stringify(scrubbed)).not.toContain('5592995550101');
  });

  it('url sem query passa intacta', () => {
    const event = { request: { url: 'https://picoa.example/contacts' } };
    expect(scrubRequestQueryString(event).request?.url).toBe(
      'https://picoa.example/contacts',
    );
  });

  it('evento sem `request` (ex.: evento de profiling): não quebra', () => {
    expect(() => scrubRequestQueryString({})).not.toThrow();
  });

  it('`request` sem `url`/`query_string`: não quebra e devolve como veio', () => {
    const event = { request: {} };
    expect(scrubRequestQueryString(event)).toEqual({ request: {} });
  });

  // Achado (review round 3): beforeSend só roda para eventos de ERRO
  // (`isErrorEvent` em @sentry/core/build/cjs/client.js checa `type ===
  // undefined`). Um evento de TRANSAÇÃO (`type: 'transaction'`) amostrado
  // por tracesSampleRate nunca passava por scrubRequestQueryString — este
  // teste prova que a mesma função serve para beforeSendTransaction, já que
  // TransactionEvent estende a mesma Event com `request`.
  it('funciona igual num evento de transação (type: "transaction"), para servir de beforeSendTransaction', () => {
    const transactionEvent = {
      type: 'transaction' as const,
      transaction: 'GET /contacts',
      request: {
        url: 'https://picoa.example/contacts?search=%2B5592995550101',
        query_string: 'search=%2B5592995550101',
      },
    };

    const scrubbed = scrubRequestQueryString(transactionEvent);

    expect(scrubbed.request?.query_string).toBeUndefined();
    expect(scrubbed.request?.url).toBe('https://picoa.example/contacts');
    expect(JSON.stringify(scrubbed)).not.toContain('5592995550101');
  });
});

/**
 * `beforeSendSpan` roda para o root span da transação E para cada span em
 * `event.spans` — e nenhum dos dois passa por `request`. A query mora em
 * atributos do próprio span (`span.data`), com nomes que variam por semconv
 * (velho/novo) e por tipo de span (servidor recebendo vs. cliente saindo).
 * Ver o docblock de `scrubSpanQueryData` em sentry.instrument.ts para as
 * fontes no SDK instalado.
 */
describe('scrubSpanQueryData — a query em atributos de SPAN nunca chega ao Sentry', () => {
  it('remove url.query e corta a query de url.full (span de servidor, semconv novo)', () => {
    const span = {
      data: {
        'url.path': '/contacts',
        'url.query': 'search=%2B5592995550101',
        'url.full':
          'https://picoa.example/contacts?search=%2B5592995550101',
      },
    };

    const scrubbed = scrubSpanQueryData(span);

    expect(scrubbed.data['url.query']).toBeUndefined();
    expect('url.query' in scrubbed.data).toBe(false);
    expect(scrubbed.data['url.full']).toBe(
      'https://picoa.example/contacts',
    );
    expect(JSON.stringify(scrubbed)).not.toContain('5592995550101');
  });

  it('corta a query de http.target e http.url (span de servidor, semconv antigo)', () => {
    const span = {
      data: {
        'http.target': '/contacts?search=%2B5592995550101',
        'http.url':
          'https://picoa.example/contacts?search=%2B5592995550101',
      },
    };

    const scrubbed = scrubSpanQueryData(span);

    expect(scrubbed.data['http.target']).toBe('/contacts');
    expect(scrubbed.data['http.url']).toBe(
      'https://picoa.example/contacts',
    );
  });

  it('remove http.query por inteiro (span http.client/fetch de saída, ex.: chamada ao provedor de WhatsApp)', () => {
    const span = {
      data: {
        'http.url': 'https://api.provider.example/lookup?phone=%2B5592995550101',
        'http.query': '?phone=%2B5592995550101',
      },
    };

    const scrubbed = scrubSpanQueryData(span);

    expect('http.query' in scrubbed.data).toBe(false);
    expect(scrubbed.data['http.url']).toBe(
      'https://api.provider.example/lookup',
    );
    expect(JSON.stringify(scrubbed)).not.toContain('5592995550101');
  });

  it('span sem nenhum atributo de query/URL passa intacto', () => {
    const span = { data: { 'sentry.op': 'db.query', 'db.system': 'postgresql' } };
    expect(scrubSpanQueryData(span)).toEqual(span);
  });

  it('span sem `data`: não quebra e devolve como veio (nunca null)', () => {
    const span = { span_id: 'abc' } as { data?: Record<string, unknown> };
    expect(scrubSpanQueryData(span)).toBe(span);
  });

  it('url.full sem query passa intacta', () => {
    const span = { data: { 'url.full': 'https://picoa.example/contacts' } };
    expect(scrubSpanQueryData(span).data['url.full']).toBe(
      'https://picoa.example/contacts',
    );
  });

  // ★ O requisito mais crítico: nunca devolver algo falsy. O SDK trata um
  // retorno falsy de beforeSendSpan como "processamento falhou" e empurra o
  // span ORIGINAL (não-scrubbed) adiante — retornar `null`/`undefined` aqui
  // seria PIOR do que não ter o hook, porque criaria uma falsa sensação de
  // proteção.
  it('nunca retorna null/undefined — sempre o span (possivelmente mutado)', () => {
    const withQuery = { data: { 'url.query': 'search=x' } };
    const withoutData = {} as { data?: Record<string, unknown> };
    expect(scrubSpanQueryData(withQuery)).toBeTruthy();
    expect(scrubSpanQueryData(withoutData)).toBeTruthy();
  });
});
