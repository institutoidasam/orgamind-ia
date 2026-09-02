import { describe, it, expect } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import {
  invalidateChat,
  invalidateConversationLists,
  invalidateConversationThread,
  chatQueries,
  dedupeById,
} from './api';
import type { ConversationSummary } from './schemas';

describe('invalidateChat', () => {
  it('invalidates a specific conversation thread and the conversation lists', () => {
    const qc = new QueryClient();
    qc.setQueryData(['chat', 'conversations', { filter: 'all', search: '' }], { items: [], total: 0, page: 1, pageSize: 30 });
    qc.setQueryData(['chat', 'conversations', 'c1', 'messages'], { pages: [], pageParams: [] });
    qc.setQueryData(['chat', 'conversations', 'c2', 'messages'], { pages: [], pageParams: [] });

    invalidateChat(qc, 'c1');

    expect(qc.getQueryState(['chat', 'conversations', { filter: 'all', search: '' }])?.isInvalidated).toBe(true);
    expect(qc.getQueryState(['chat', 'conversations', 'c1', 'messages'])?.isInvalidated).toBe(true);
    expect(qc.getQueryState(['chat', 'conversations', 'c2', 'messages'])?.isInvalidated).toBe(false);
  });
});

// As invalidações granulares existem para o stream SSE: numa rajada de acks a
// LISTA é throttled, mas a conversa aberta é invalidada na hora. Cada uma só
// pode tocar no seu pedaço.
describe('invalidateConversationLists / invalidateConversationThread', () => {
  function seed() {
    const qc = new QueryClient();
    qc.setQueryData(['chat', 'conversations', { filter: 'all', search: '' }], { pages: [], pageParams: [] });
    qc.setQueryData(['chat', 'conversations', 'c1'], {});
    qc.setQueryData(['chat', 'conversations', 'c1', 'messages'], { pages: [], pageParams: [] });
    return qc;
  }

  it('lists: invalida as listas SEM derrubar a conversa aberta', () => {
    const qc = seed();
    invalidateConversationLists(qc);

    expect(qc.getQueryState(['chat', 'conversations', { filter: 'all', search: '' }])?.isInvalidated).toBe(true);
    expect(qc.getQueryState(['chat', 'conversations', 'c1'])?.isInvalidated).toBe(false);
    expect(qc.getQueryState(['chat', 'conversations', 'c1', 'messages'])?.isInvalidated).toBe(false);
  });

  it('thread: invalida resumo + mensagens da conversa SEM tocar nas listas', () => {
    const qc = seed();
    invalidateConversationThread(qc, 'c1');

    expect(qc.getQueryState(['chat', 'conversations', 'c1'])?.isInvalidated).toBe(true);
    expect(qc.getQueryState(['chat', 'conversations', 'c1', 'messages'])?.isInvalidated).toBe(true);
    expect(qc.getQueryState(['chat', 'conversations', { filter: 'all', search: '' }])?.isInvalidated).toBe(false);
  });
});

describe('chatQueries.conversations — instanceId', () => {
  it('includes instanceId in the queryKey when provided', () => {
    const opts = chatQueries.conversations('all', '', 'inst-42');
    expect(opts.queryKey).toEqual(['chat', 'conversations', { filter: 'all', search: '', instanceId: 'inst-42' }]);
  });

  it('omits instanceId from the queryKey when not provided', () => {
    const opts = chatQueries.conversations('all', '');
    expect(opts.queryKey).toEqual(['chat', 'conversations', { filter: 'all', search: '' }]);
  });

  it('includes assignee in the queryKey when provided', () => {
    const opts = chatQueries.conversations('all', '', undefined, 'me');
    expect(opts.queryKey).toEqual(['chat', 'conversations', { filter: 'all', search: '', assignee: 'me' }]);
  });

  it('omits assignee from the queryKey when not provided', () => {
    const opts = chatQueries.conversations('all', '');
    expect(opts.queryKey).toEqual(['chat', 'conversations', { filter: 'all', search: '' }]);
  });
});

// F4b — the inbox provider filter must be sent to the backend (server-side
// filtering, before the page cut) instead of being applied client-side over
// an already-paginated page.
describe('chatQueries.conversations — provider (F4b)', () => {
  it('includes provider in the queryKey when provided', () => {
    const opts = chatQueries.conversations('all', '', undefined, undefined, 'TWILIO');
    expect(opts.queryKey).toEqual(['chat', 'conversations', { filter: 'all', search: '', provider: 'TWILIO' }]);
  });

  it('omits provider from the queryKey when not provided', () => {
    const opts = chatQueries.conversations('all', '');
    expect(opts.queryKey).toEqual(['chat', 'conversations', { filter: 'all', search: '' }]);
  });

  it('combines provider with instanceId and assignee in the queryKey', () => {
    const opts = chatQueries.conversations('all', '', 'inst-1', 'me', 'EVOLUTION');
    expect(opts.queryKey).toEqual([
      'chat',
      'conversations',
      { filter: 'all', search: '', instanceId: 'inst-1', assignee: 'me', provider: 'EVOLUTION' },
    ]);
  });
});

// A lista de conversas sempre foi paginada no backend (page/pageSize, padrão
// 30) — mas o frontend nunca pedia a página 2: com 138 conversas o operador só
// alcançava as 30 mais recentes, sem indício de que faltava alguma. A query
// virou infinita para o scroll carregar o resto.
describe('chatQueries.conversations — paginação', () => {
  const page = (n: number, total: number, pageSize = 30) => ({
    items: [] as ConversationSummary[], total, page: n, pageSize,
  });

  it('começa na página 1', () => {
    const opts = chatQueries.conversations('all', '');
    expect(opts.initialPageParam).toBe(1);
  });

  it('pede a próxima página enquanto o carregado não cobre o total', () => {
    const opts = chatQueries.conversations('all', '');
    expect(opts.getNextPageParam(page(1, 138), [page(1, 138)], 1, [1])).toBe(2);
    expect(opts.getNextPageParam(page(4, 138), [page(4, 138)], 4, [4])).toBe(5);
  });

  it('para quando a última página cobre o total (nada de página vazia extra)', () => {
    const opts = chatQueries.conversations('all', '');
    expect(opts.getNextPageParam(page(5, 138), [page(5, 138)], 5, [5])).toBeUndefined();
    expect(opts.getNextPageParam(page(1, 0), [page(1, 0)], 1, [1])).toBeUndefined();
    expect(opts.getNextPageParam(page(1, 30), [page(1, 30)], 1, [1])).toBeUndefined();
  });
});

describe('dedupeById', () => {
  const conv = (id: string) => ({ id }) as ConversationSummary;

  it('remove a conversa repetida mantendo a primeira ocorrência (a mais recente na ordenação)', () => {
    // A lista é viva: entre o fetch da página 1 e o da 2, uma conversa pode
    // subir de posição e aparecer nas DUAS páginas.
    const out = dedupeById([conv('a'), conv('b'), conv('a'), conv('c')]);
    expect(out.map((c) => c.id)).toEqual(['a', 'b', 'c']);
  });
});
