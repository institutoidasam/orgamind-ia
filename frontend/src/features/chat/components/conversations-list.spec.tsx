import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import type { ConversationSummary } from '../schemas';

// Captura os args com que useConversations é chamado a cada render, para
// asserir debounce/filtros. `provider` (5º arg) existe só para provar que a
// lista NÃO o envia mais (R14: sem filtro de provedor na query).
const conversationsCalls: Array<{ filter: string; search: string; instanceId?: string; assignee?: string; provider?: string }> = [];
let conversationsData: { items: ConversationSummary[]; total: number; page: number; pageSize: number } = {
  items: [], total: 0, page: 1, pageSize: 30,
};
// Paginação (query infinita): o hook real expõe fetchNextPage/hasNextPage —
// o mock os torna controláveis por teste.
let hasNextPageValue = false;
const fetchNextPageMock = vi.fn();
vi.mock('../api', () => ({
  // O hook real (query infinita) entrega `data` já achatado via select:
  // { items, total } — o mock devolve a mesma forma.
  useConversations: (filter: string, search: string, instanceId?: string, assignee?: string, provider?: string) => {
    conversationsCalls.push({ filter, search, instanceId, assignee, provider });
    return {
      data: { items: conversationsData.items, total: conversationsData.total },
      isLoading: false, isError: false, error: null, refetch: vi.fn(),
      fetchNextPage: fetchNextPageMock, hasNextPage: hasNextPageValue, isFetchingNextPage: false,
    };
  },
}));
// /whatsapp/providers: a lista não o consome mais; o mock existe para provar
// que um GOZAP ainda configurado não vira aba nem pré-seleção.
type ProviderTraitsStub = { official: boolean; sessionBased: boolean; sessionWindow: boolean };
const TRAITS_BY_PROVIDER: Record<string, ProviderTraitsStub> = {
  EVOLUTION: { official: false, sessionBased: true, sessionWindow: false },
  GOZAP: { official: false, sessionBased: true, sessionWindow: false },
};
let providersData: { providers: Array<{ provider: string; traits: ProviderTraitsStub; channels: never[] }> } = {
  providers: [{ provider: 'EVOLUTION', traits: TRAITS_BY_PROVIDER.EVOLUTION, channels: [] }],
};
// Evolution instances (connection-state aware) — settable per test so the
// número tab bar can be exercised.
let instancesData: Array<{ id: string; name: string; lastConnectionState: string | null }> = [];
vi.mock('@/features/whatsapp/api', () => ({
  useInstances: () => ({ data: instancesData }),
  useProviders: () => ({ data: providersData }),
  // provider-scope.tsx (ProviderBadge, usado de verdade pela linha) lê esta
  // constante no escopo do módulo.
  CHANNEL_PROVIDERS: ['EVOLUTION', 'TWILIO', 'ZERNIO', 'META', 'GOZAP'],
}));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));
vi.mock('@/stores/auth.store', () => ({ useAuthStore: (sel: (s: unknown) => unknown) => sel({ user: { id: 'u1' } }) }));

import { ConversationsList } from './conversations-list';

function mkConversation(overrides: Partial<ConversationSummary> & { id: string }): ConversationSummary {
  return {
    instanceId: 'i1', instanceName: 'Número A', remoteJid: `${overrides.id}@s.whatsapp.net`,
    phoneE164: null, contactId: null, displayName: overrides.id, waName: null, profilePicUrl: null,
    lastMessageAt: null, lastMessagePreview: null, lastMessageDirection: null, unreadCount: 0,
    ...overrides,
  };
}

beforeEach(() => {
  conversationsData = { items: [], total: 0, page: 1, pageSize: 30 };
  providersData = { providers: [{ provider: 'EVOLUTION', traits: TRAITS_BY_PROVIDER.EVOLUTION, channels: [] }] };
  instancesData = [];
  hasNextPageValue = false;
  fetchNextPageMock.mockClear();
});

describe('ConversationsList search debounce', () => {
  beforeEach(() => {
    conversationsCalls.length = 0;
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('does not query on every keystroke — debounces the search term', () => {
    render(<ConversationsList />);
    const input = screen.getByPlaceholderText('Buscar conversa…');

    // Type four characters rapidly (no time passes between them).
    act(() => { fireEvent.change(input, { target: { value: 'a' } }); });
    act(() => { fireEvent.change(input, { target: { value: 'an' } }); });
    act(() => { fireEvent.change(input, { target: { value: 'ana' } }); });
    act(() => { fireEvent.change(input, { target: { value: 'anak' } }); });

    // The debounced search value must NOT have reached useConversations yet:
    // every call so far should still carry the empty (pre-typing) search.
    const searchesBeforeDebounce = conversationsCalls.map((c) => c.search);
    expect(searchesBeforeDebounce).not.toContain('a');
    expect(searchesBeforeDebounce).not.toContain('an');
    expect(searchesBeforeDebounce).not.toContain('ana');
    expect(searchesBeforeDebounce.filter((s) => s === 'anak')).toHaveLength(0);

    // After the debounce window elapses, exactly the final value flows through.
    act(() => { vi.advanceTimersByTime(350); });
    const last = conversationsCalls[conversationsCalls.length - 1];
    expect(last.search).toBe('anak');
    // The intermediate values were never queried.
    expect(conversationsCalls.some((c) => c.search === 'a' || c.search === 'an' || c.search === 'ana')).toBe(false);
  });
});

describe('ConversationsList filter header', () => {
  beforeEach(() => {
    conversationsCalls.length = 0;
  });

  it('renders a single "Todas" pill (the assignee one) — read-filter row is gone', () => {
    render(<ConversationsList />);
    expect(screen.getAllByText('Todas')).toHaveLength(1);
  });

  it('unread toggle sits beside search and toggles aria-pressed + the query filter', () => {
    render(<ConversationsList />);
    const toggle = screen.getByRole('button', { name: 'Não lidas' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    // useConversations must now have been called with 'unread' as first arg
    // (and no instance/assignee filter active).
    const last = conversationsCalls[conversationsCalls.length - 1];
    expect(last.filter).toBe('unread');
    expect(last.instanceId).toBeUndefined();
    expect(last.assignee).toBeUndefined();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
  });

  // "Aguardando resposta" — o CONTATO falou por último e ninguém respondeu
  // ainda (lastMessageDirection === 'INBOUND' no backend). Mesmo padrão do
  // toggle "Não lidas" acima: um botão que reflete/seta `filter`.
  it('awaiting-response toggle sits beside the unread one and toggles aria-pressed + the query filter', () => {
    render(<ConversationsList />);
    const toggle = screen.getByRole('button', { name: 'Aguardando resposta' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    const last = conversationsCalls[conversationsCalls.length - 1];
    expect(last.filter).toBe('awaiting');
    expect(last.instanceId).toBeUndefined();
    expect(last.assignee).toBeUndefined();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(conversationsCalls[conversationsCalls.length - 1].filter).toBe('all');
  });

  it('selecting "Aguardando resposta" while "Não lidas" is active switches (mutually exclusive) instead of combining', () => {
    render(<ConversationsList />);
    const unread = screen.getByRole('button', { name: 'Não lidas' });
    const awaiting = screen.getByRole('button', { name: 'Aguardando resposta' });
    fireEvent.click(unread);
    expect(unread).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(awaiting);
    expect(awaiting).toHaveAttribute('aria-pressed', 'true');
    expect(unread).toHaveAttribute('aria-pressed', 'false');
    expect(conversationsCalls[conversationsCalls.length - 1].filter).toBe('awaiting');
  });
});

// F4b — multi-provider channels: inbox provider badge + filter, now applied
// server-side (the `provider` param sent to useConversations) instead of
// client-side over an already-loaded page.
// R14: sem abas de provedor nem filtro de provedor na query, e sem o default
// GOZAP. O badge por linha fica, para ler o histórico misto (conversas de
// números hoje desligados convivem com as da Evolution).
describe('ConversationsList histórico misto (somente Evolution)', () => {
  beforeEach(() => {
    conversationsCalls.length = 0;
    conversationsData = {
      items: [
        mkConversation({ id: 'Ana', provider: 'EVOLUTION' }),
        mkConversation({ id: 'Bruno', provider: 'GOZAP' }),
      ],
      total: 2, page: 1, pageSize: 30,
    };
    // Mesmo com um GOZAP ainda configurado, nada é pré-selecionado.
    providersData = {
      providers: [
        { provider: 'EVOLUTION', traits: TRAITS_BY_PROVIDER.EVOLUTION, channels: [] },
        { provider: 'GOZAP', traits: TRAITS_BY_PROVIDER.GOZAP, channels: [] },
      ],
    };
  });

  it('não pré-seleciona GOZAP nem mostra abas de provedor', () => {
    render(<ConversationsList />);
    // Sem filtro de provedor na query: a conversa GoZap continua na lista.
    expect(conversationsCalls.every((c) => c.provider === undefined)).toBe(true);
    expect(screen.getByText('Ana')).toBeInTheDocument();
    expect(screen.getByText('Bruno')).toBeInTheDocument();
    // Nenhuma aba de provedor ("Todos" / nome do provedor).
    expect(screen.queryByRole('button', { name: 'Todos' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'GoZap' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Evolution' })).not.toBeInTheDocument();
  });

  it('mostra o badge de provedor por linha quando a página mistura 2+ provedores', () => {
    render(<ConversationsList />);
    // Só o badge da linha (sem aba de provedor): exatamente uma ocorrência de cada.
    expect(screen.getAllByText('Evolution')).toHaveLength(1);
    expect(screen.getAllByText('GoZap')).toHaveLength(1);
  });

  it('esconde o badge quando a página tem um único provedor', () => {
    conversationsData = { items: [mkConversation({ id: 'Ana', provider: 'EVOLUTION' })], total: 1, page: 1, pageSize: 30 };
    render(<ConversationsList />);
    expect(screen.queryByText('Evolution')).not.toBeInTheDocument();
  });

  it('mostra a mensagem de lista vazia quando a página vem vazia', () => {
    conversationsData = { items: [], total: 0, page: 1, pageSize: 30 };
    render(<ConversationsList />);
    expect(screen.getByText('Nenhuma conversa ainda.')).toBeInTheDocument();
  });
});

// Paginação: o backend sempre paginou (30 por página) e o frontend nunca
// pedia a página 2 — com 138 conversas o operador só via as 30 mais recentes,
// sem indício de que faltava alguma. O "Carregar mais" é o sentinela do scroll
// infinito E o fallback clicável (jsdom não tem IntersectionObserver — o
// clique é o que dá para exercitar aqui).
describe('ConversationsList paginação (carregar mais)', () => {
  beforeEach(() => {
    conversationsData = {
      items: [mkConversation({ id: 'Ana' }), mkConversation({ id: 'Bruno' })],
      total: 138, page: 1, pageSize: 30,
    };
  });

  it('não mostra o botão quando tudo já carregou', () => {
    hasNextPageValue = false;
    render(<ConversationsList />);
    expect(screen.queryByRole('button', { name: /carregar mais/i })).not.toBeInTheDocument();
  });

  it('mostra quanto falta e busca a próxima página no clique', () => {
    hasNextPageValue = true;
    render(<ConversationsList />);

    const btn = screen.getByRole('button', { name: /carregar mais/i });
    // O operador precisa SABER que há mais — era exatamente o que faltava.
    expect(btn).toHaveTextContent('2 de 138');
    fireEvent.click(btn);
    expect(fetchNextPageMock).toHaveBeenCalled();
  });
});

// Barra de abas "número": só números Evolution conectados (único provedor
// ligado — R14). Selecionar uma aba filtra a lista por instanceId.
describe('ConversationsList abas de número (Evolution conectados)', () => {
  beforeEach(() => {
    conversationsCalls.length = 0;
    instancesData = [
      { id: 'i1', name: 'Número A', lastConnectionState: 'open' },
      { id: 'i2', name: 'Número B', lastConnectionState: 'open' },
      { id: 'i3', name: 'Número C', lastConnectionState: 'close' },
    ];
  });

  it('oferece só os conectados e a seleção filtra por instanceId', () => {
    render(<ConversationsList />);
    expect(screen.queryByRole('button', { name: /Número C/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Número B/ }));
    expect(conversationsCalls[conversationsCalls.length - 1].instanceId).toBe('i2');
  });
});
