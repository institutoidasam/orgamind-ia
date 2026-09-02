import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import type { ConversationSummary } from '../schemas';

// Capture the (filter, search, instanceId, assignee, provider) args
// useConversations is called with on each render so we can assert
// debounce/filter behaviour.
const conversationsCalls: Array<{ filter: string; search: string; instanceId?: string; assignee?: string; provider?: string }> = [];
let conversationsData: { items: ConversationSummary[]; total: number; page: number; pageSize: number } = {
  items: [], total: 0, page: 1, pageSize: 30,
};
// Paginação (query infinita): o hook real expõe fetchNextPage/hasNextPage —
// o mock os torna controláveis por teste.
let hasNextPageValue = false;
const fetchNextPageMock = vi.fn();
vi.mock('../api', () => ({
  // F4b: the provider filter is now applied server-side. This mock stands in
  // for that backend behaviour — it filters conversationsData by the
  // `provider` param it receives, the same way ChatRepository.listConversations
  // now filters by where.instance.provider before the page cut — so the
  // component under test is exercised exactly as it would be against the
  // real API: it must send the right `provider` param to get the right page,
  // and it must render `data.items` as-is (no client-side re-filtering).
  // O hook real (query infinita) entrega `data` já achatado via select:
  // { items, total } — o mock devolve a mesma forma.
  useConversations: (filter: string, search: string, instanceId?: string, assignee?: string, provider?: string) => {
    conversationsCalls.push({ filter, search, instanceId, assignee, provider });
    const items = provider ? conversationsData.items.filter((c) => c.provider === provider) : conversationsData.items;
    return {
      data: { items, total: provider ? items.length : conversationsData.total },
      isLoading: false, isError: false, error: null, refetch: vi.fn(),
      fetchNextPage: fetchNextPageMock, hasNextPage: hasNextPageValue, isFetchingNextPage: false,
    };
  },
}));
// Multi-provider channels (F4): defaults to a single configured provider so
// ProviderTabs stays hidden (matching the pre-F4 no-op behaviour) unless a
// test explicitly opts into 2+ providers.
type ChannelStub = { id: string; name: string; phoneE164: string | null; isActive: boolean; isDefault: boolean; provider: string };
type ProviderTraitsStub = { official: boolean; sessionBased: boolean; sessionWindow: boolean };
// Traits REAIS que o backend expõe hoje por provider (contrato da Task 4) —
// fixture usada pelos grupos de /providers abaixo, não uma asserção do gate.
const TRAITS_BY_PROVIDER: Record<string, ProviderTraitsStub> = {
  EVOLUTION: { official: false, sessionBased: true, sessionWindow: false },
  TWILIO: { official: true, sessionBased: false, sessionWindow: true },
  ZERNIO: { official: true, sessionBased: false, sessionWindow: true },
  META: { official: true, sessionBased: false, sessionWindow: false },
  // GOZAP (channel-provider.schema.ts): sessionBased: true — pareia por QR
  // como o Evolution — mas GET /whatsapp/instances é Evolution-only, então
  // GOZAP não tem NENHUMA outra fonte de estado de conexão.
  GOZAP: { official: false, sessionBased: true, sessionWindow: false },
};
let providersData: { providers: Array<{ provider: string; traits: ProviderTraitsStub; channels: ChannelStub[] }> } = {
  providers: [{ provider: 'EVOLUTION', traits: TRAITS_BY_PROVIDER.EVOLUTION, channels: [] }],
};
// Evolution instances (connection-state aware) — settable per test so the
// número tab bar can be exercised (T7: cloud channels join it).
let instancesData: Array<{ id: string; name: string; lastConnectionState: string | null }> = [];
let scopeValue: string = 'all';
const setScopeMock = vi.fn();
vi.mock('@/features/whatsapp/api', () => ({
  useInstances: () => ({ data: instancesData }),
  useProviders: () => ({ data: providersData }),
  // provider-scope.tsx (used for real via importOriginal below) reads this
  // constant at module scope.
  CHANNEL_PROVIDERS: ['EVOLUTION', 'TWILIO', 'ZERNIO', 'META', 'GOZAP'],
}));
vi.mock('@/features/whatsapp/provider-scope', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/whatsapp/provider-scope')>();
  return { ...actual, useProviderScope: () => ({ scope: scopeValue, setScope: setScopeMock }) };
});
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
  scopeValue = 'all';
  setScopeMock.mockClear();
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
describe('ConversationsList provider filter (F4b)', () => {
  // ZERNIO como segundo provider genérico (não é TWILIO nem GOZAP — ambos
  // ganharam tratamento especial no ajuste do cliente de 2026-08-25: TWILIO
  // some da UI, GOZAP vira padrão). O mecanismo de filtro em si continua
  // coberto de forma provider-agnóstica por este bloco.
  beforeEach(() => {
    conversationsCalls.length = 0;
    conversationsData = {
      items: [
        mkConversation({ id: 'Ana', provider: 'EVOLUTION' }),
        mkConversation({ id: 'Bruno', provider: 'ZERNIO' }),
      ],
      total: 2, page: 1, pageSize: 30,
    };
    providersData = {
      providers: [
        { provider: 'EVOLUTION', traits: TRAITS_BY_PROVIDER.EVOLUTION, channels: [] },
        { provider: 'ZERNIO', traits: TRAITS_BY_PROVIDER.ZERNIO, channels: [] },
      ],
    };
  });

  it('does not send a provider param when the filter is "all"', () => {
    render(<ConversationsList />);
    const last = conversationsCalls[conversationsCalls.length - 1];
    expect(last.provider).toBeUndefined();
  });

  it('shows the provider badge only when the filter is "all" and 2+ providers are present in the loaded page', () => {
    render(<ConversationsList />);
    // Both providers are represented in the loaded (unfiltered) list: one
    // match is the ProviderTabs tab, the other is each row's ProviderBadge.
    expect(screen.getAllByText('Evolution').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('Zernio').length).toBeGreaterThanOrEqual(2);
  });

  it('hides the provider badge when only a single provider is configured/loaded', () => {
    providersData = { providers: [{ provider: 'EVOLUTION', traits: TRAITS_BY_PROVIDER.EVOLUTION, channels: [] }] };
    conversationsData = { items: [mkConversation({ id: 'Ana', provider: 'EVOLUTION' })], total: 1, page: 1, pageSize: 30 };
    render(<ConversationsList />);
    expect(screen.queryByText('Evolution')).not.toBeInTheDocument();
  });

  // Badge decision (F4b): once a specific provider is selected, the filtered
  // page is single-provider by construction (the backend filter guarantees
  // it) — so the badge would be redundant. Guarded on `providerFilter ===
  // 'all'` in ConversationsList rather than just "2+ distinct providers in
  // the page", since a filtered page can never legitimately mix providers.
  it('hides the provider badge once a specific provider tab is selected', () => {
    render(<ConversationsList />);
    fireEvent.click(screen.getByRole('button', { name: 'Zernio' }));
    // Only the ProviderTabs tab label remains — no per-row ProviderBadge.
    expect(screen.getAllByText('Zernio')).toHaveLength(1);
  });

  it('selecting a provider tab sends that provider as a server-side filter param, "Todos" clears it', () => {
    render(<ConversationsList />);
    expect(screen.getByText('Ana')).toBeInTheDocument();
    expect(screen.getByText('Bruno')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Zernio' }));
    expect(conversationsCalls[conversationsCalls.length - 1].provider).toBe('ZERNIO');
    // The mock stands in for the backend's where.instance.provider filter —
    // the component must render exactly what the (now server-filtered) page
    // contains, with no client-side re-filtering of its own.
    expect(screen.queryByText('Ana')).not.toBeInTheDocument();
    expect(screen.getByText('Bruno')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Todos' }));
    expect(conversationsCalls[conversationsCalls.length - 1].provider).toBeUndefined();
    expect(screen.getByText('Ana')).toBeInTheDocument();
    expect(screen.getByText('Bruno')).toBeInTheDocument();
  });

  it('estado inicial respeita o escopo global (useProviderScope), sem alterá-lo ao trocar localmente', () => {
    scopeValue = 'ZERNIO';
    render(<ConversationsList />);
    // Initial filter came from the global scope ('ZERNIO') — sent as the
    // provider param, and only Bruno shows (server-filtered page).
    expect(conversationsCalls[0].provider).toBe('ZERNIO');
    expect(screen.queryByText('Ana')).not.toBeInTheDocument();
    expect(screen.getByText('Bruno')).toBeInTheDocument();

    // Changing the tab locally must NOT call the global setScope.
    fireEvent.click(screen.getByRole('button', { name: 'Todos' }));
    expect(screen.getByText('Ana')).toBeInTheDocument();
    expect(setScopeMock).not.toHaveBeenCalled();
  });

  it('shows the provider-specific empty message when the filter is active and the server page is empty', () => {
    conversationsData = { items: [], total: 0, page: 1, pageSize: 30 };
    render(<ConversationsList />);
    fireEvent.click(screen.getByRole('button', { name: 'Zernio' }));
    expect(screen.getByText('Nenhuma conversa deste provedor.')).toBeInTheDocument();
    expect(screen.queryByText('Nenhuma conversa ainda.')).not.toBeInTheDocument();
  });

  it('shows the generic empty message when unfiltered and the page is empty', () => {
    conversationsData = { items: [], total: 0, page: 1, pageSize: 30 };
    render(<ConversationsList />);
    expect(screen.getByText('Nenhuma conversa ainda.')).toBeInTheDocument();
  });
});

// Ajuste do cliente (2026-08-25): TWILIO some da tela do inbox (abas/seletor
// de provedor) e GOZAP vira o canal padrão — pré-selecionado ao abrir, sem
// que o operador precise clicar em nada.
describe('ConversationsList — TWILIO fora, GOZAP padrão (ajuste do cliente 2026-08-25)', () => {
  beforeEach(() => {
    conversationsCalls.length = 0;
    conversationsData = { items: [], total: 0, page: 1, pageSize: 30 };
  });

  it('nunca oferece TWILIO como aba de provedor, mesmo configurado', () => {
    providersData = {
      providers: [
        { provider: 'EVOLUTION', traits: TRAITS_BY_PROVIDER.EVOLUTION, channels: [] },
        { provider: 'TWILIO', traits: TRAITS_BY_PROVIDER.TWILIO, channels: [] },
        { provider: 'GOZAP', traits: TRAITS_BY_PROVIDER.GOZAP, channels: [] },
      ],
    };
    render(<ConversationsList />);
    expect(screen.queryByRole('button', { name: 'Twilio' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Evolution' })).toBeInTheDocument();
  });

  it('GOZAP pré-seleciona sozinho ao abrir, quando o escopo global é "all"', () => {
    scopeValue = 'all';
    providersData = {
      providers: [
        { provider: 'EVOLUTION', traits: TRAITS_BY_PROVIDER.EVOLUTION, channels: [] },
        { provider: 'GOZAP', traits: TRAITS_BY_PROVIDER.GOZAP, channels: [] },
      ],
    };
    render(<ConversationsList />);
    const last = conversationsCalls[conversationsCalls.length - 1];
    expect(last.provider).toBe('GOZAP');
    // A aba GOZAP aparece marcada como ativa (o botão "Todos" segue presente,
    // só não é o que está selecionado).
    expect(screen.getByRole('button', { name: 'GoZap' })).toBeInTheDocument();
  });

  it('não sobrescreve uma preferência EXPLÍCITA do escopo global (ex.: EVOLUTION fixado no topbar)', () => {
    scopeValue = 'EVOLUTION';
    providersData = {
      providers: [
        { provider: 'EVOLUTION', traits: TRAITS_BY_PROVIDER.EVOLUTION, channels: [] },
        { provider: 'GOZAP', traits: TRAITS_BY_PROVIDER.GOZAP, channels: [] },
      ],
    };
    render(<ConversationsList />);
    expect(conversationsCalls[0].provider).toBe('EVOLUTION');
  });

  it('sem GOZAP configurado, o padrão continua "Todos" (nada para pré-selecionar)', () => {
    scopeValue = 'all';
    providersData = {
      providers: [
        { provider: 'EVOLUTION', traits: TRAITS_BY_PROVIDER.EVOLUTION, channels: [] },
        { provider: 'ZERNIO', traits: TRAITS_BY_PROVIDER.ZERNIO, channels: [] },
      ],
    };
    render(<ConversationsList />);
    const last = conversationsCalls[conversationsCalls.length - 1];
    expect(last.provider).toBeUndefined();
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

// T7 (twilio-platform): canais cloud (provider !== EVOLUTION) não têm estado
// de conexão — o filtro por 'open' não se aplica a eles. Todo canal cloud
// ATIVO entra na barra de abas "número" ao lado dos Evolution conectados.
//
// Usa ZERNIO como provider cloud genérico (não TWILIO): o ajuste do cliente
// de 2026-08-25 tirou TWILIO desta barra — ver o describe dedicado logo
// abaixo, que prova exatamente essa exclusão.
describe('ConversationsList abas de número incluem canais cloud (T7)', () => {
  const zernioChannel = (over: Partial<ChannelStub> = {}): ChannelStub => ({
    id: 'zn1', name: 'Zernio Principal', phoneE164: '+5511999', isActive: true, isDefault: true, provider: 'ZERNIO',
    ...over,
  });

  beforeEach(() => {
    conversationsCalls.length = 0;
    instancesData = [{ id: 'i1', name: 'Número A', lastConnectionState: 'open' }];
    providersData = {
      providers: [
        { provider: 'EVOLUTION', traits: TRAITS_BY_PROVIDER.EVOLUTION, channels: [] },
        { provider: 'ZERNIO', traits: TRAITS_BY_PROVIDER.ZERNIO, channels: [zernioChannel()] },
      ],
    };
  });

  it('mostra um canal ZERNIO ativo como aba ao lado do Evolution conectado', () => {
    render(<ConversationsList />);
    expect(screen.getByRole('button', { name: /Zernio Principal/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Número A/ })).toBeInTheDocument();
  });

  it('não mostra canal cloud inativo (soft-deleted)', () => {
    providersData.providers[1].channels = [zernioChannel({ isActive: false })];
    render(<ConversationsList />);
    expect(screen.queryByRole('button', { name: /Zernio Principal/ })).not.toBeInTheDocument();
    // Sem o canal cloud sobra só 1 número — a barra de abas continua oculta.
    expect(screen.queryByRole('button', { name: /Número A/ })).not.toBeInTheDocument();
  });

  it('selecionar a aba do canal ZERNIO filtra por instanceId e a seleção não é resetada', () => {
    render(<ConversationsList />);
    fireEvent.click(screen.getByRole('button', { name: /Zernio Principal/ }));
    const last = conversationsCalls[conversationsCalls.length - 1];
    // O fallback "instância sumiu → Todos" NÃO pode tratar um canal cloud
    // (sem connection state) como desconectado e resetar a aba.
    expect(last.instanceId).toBe('zn1');
  });

  it('canais cloud aparecem mesmo sem nenhum Evolution conectado', () => {
    instancesData = [{ id: 'i1', name: 'Número A', lastConnectionState: 'close' }];
    providersData.providers[1].channels = [
      zernioChannel(),
      zernioChannel({ id: 'zn2', name: 'Zernio Secundário', isDefault: false }),
    ];
    render(<ConversationsList />);
    expect(screen.getByRole('button', { name: /Zernio Principal/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Zernio Secundário/ })).toBeInTheDocument();
    // Evolution desconectado continua fora da barra (comportamento intacto).
    expect(screen.queryByRole('button', { name: /Número A/ })).not.toBeInTheDocument();
  });
});

// Ajuste do cliente (2026-08-25): um canal TWILIO ativo não entra mais na
// barra de número do inbox — mesma exclusão do ProviderTabs, agora para a
// barra "por instância/canal".
describe('ConversationsList nunca mostra canal TWILIO na barra de número (ajuste do cliente 2026-08-25)', () => {
  const twilioChannel = (over: Partial<ChannelStub> = {}): ChannelStub => ({
    id: 'tw1', name: 'Twilio Principal', phoneE164: '+5511999', isActive: true, isDefault: true, provider: 'TWILIO',
    ...over,
  });

  it('canal TWILIO ativo some da barra de número mesmo com outro canal cloud presente', () => {
    conversationsCalls.length = 0;
    instancesData = [{ id: 'i1', name: 'Número A', lastConnectionState: 'open' }];
    providersData = {
      providers: [
        { provider: 'EVOLUTION', traits: TRAITS_BY_PROVIDER.EVOLUTION, channels: [] },
        { provider: 'TWILIO', traits: TRAITS_BY_PROVIDER.TWILIO, channels: [twilioChannel()] },
        {
          provider: 'GOZAP', traits: TRAITS_BY_PROVIDER.GOZAP,
          channels: [{ id: 'gz1', name: 'GoZap Principal', phoneE164: '+5511888', isActive: true, isDefault: true, provider: 'GOZAP' }],
        },
      ],
    };
    render(<ConversationsList />);
    expect(screen.queryByRole('button', { name: /Twilio Principal/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /GoZap Principal/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Número A/ })).toBeInTheDocument();
  });
});

// PACOTE 7 (backlog-auditoria): GOZAP é `sessionBased: true` — mesmo trait do
// EVOLUTION (pareamento por QR) — mas GET /whatsapp/instances é
// Evolution-only. Um filtro por `!traits.sessionBased` (em vez de
// `provider !== 'EVOLUTION'`) descarta GOZAP por INTEIRO: nem entra via
// `connected` (não é Evolution) nem via canais "cloud" (é sessionBased).
// O canal GOZAP ativo simplesmente não existe para o operador — nem aba, nem
// badge de instância.
describe('ConversationsList abas de número incluem canais GOZAP (Pacote 7)', () => {
  const gozapChannel = (over: Partial<ChannelStub> = {}): ChannelStub => ({
    id: 'gz1', name: 'GoZap Principal', phoneE164: '+5511888', isActive: true, isDefault: true, provider: 'GOZAP',
    ...over,
  });

  beforeEach(() => {
    conversationsCalls.length = 0;
    instancesData = [{ id: 'i1', name: 'Número A', lastConnectionState: 'open' }];
    providersData = {
      providers: [
        { provider: 'EVOLUTION', traits: TRAITS_BY_PROVIDER.EVOLUTION, channels: [] },
        { provider: 'GOZAP', traits: TRAITS_BY_PROVIDER.GOZAP, channels: [gozapChannel()] },
      ],
    };
  });

  it('mostra um canal GOZAP ativo como aba ao lado do Evolution conectado', () => {
    render(<ConversationsList />);
    expect(screen.getByRole('button', { name: /GoZap Principal/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Número A/ })).toBeInTheDocument();
  });

  it('canal GOZAP aparece mesmo sem nenhum Evolution conectado', () => {
    // InboxTabs só renderiza com 2+ canais (instances.length < 2 → null) —
    // por isso, como no teste TWILIO análogo acima, dois canais GOZAP.
    instancesData = [{ id: 'i1', name: 'Número A', lastConnectionState: 'close' }];
    providersData.providers[1].channels = [
      gozapChannel(),
      gozapChannel({ id: 'gz2', name: 'GoZap Secundário', isDefault: false }),
    ];
    render(<ConversationsList />);
    expect(screen.getByRole('button', { name: /GoZap Principal/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /GoZap Secundário/ })).toBeInTheDocument();
    // Evolution desconectado continua fora da barra (comportamento intacto).
    expect(screen.queryByRole('button', { name: /Número A/ })).not.toBeInTheDocument();
  });

  it('não mostra canal GOZAP inativo', () => {
    providersData.providers[1].channels = [gozapChannel({ isActive: false })];
    render(<ConversationsList />);
    expect(screen.queryByRole('button', { name: /GoZap Principal/ })).not.toBeInTheDocument();
  });

  // Equivalente ao teste TWILIO acima ('seleção não é resetada'): mesmo
  // array `channels` e mesmo effect de reconciliação (conversations-list.tsx)
  // — hoje o caminho já é coberto indiretamente pelo teste TWILIO, mas sem um
  // teste GOZAP dedicado uma futura diferenciação por provider nesse effect
  // (ex.: um `if (provider === 'GOZAP')` acidental) passaria despercebida: o
  // operador veria a aba GOZAP resetar sozinha para "Todos" no meio do
  // atendimento.
  it('selecionar a aba do canal GOZAP filtra por instanceId e a seleção não é resetada', () => {
    render(<ConversationsList />);
    fireEvent.click(screen.getByRole('button', { name: /GoZap Principal/ }));
    const last = conversationsCalls[conversationsCalls.length - 1];
    expect(last.instanceId).toBe('gz1');
  });
});
