import { useEffect, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useConversations } from '../api';
import { ConversationRow } from './conversation-row';
import { QueryErrorFallback } from '@/components/query-error-fallback';
import { InboxTabs } from './inbox-tabs';
import { ProviderTabs } from './provider-tabs';
import { AssigneeTabs, type AssigneeFilter } from './assignee-tabs';
import { useInstances, useProviders } from '@/features/whatsapp/api';
import { useProviderScope, type ProviderScope } from '@/features/whatsapp/provider-scope';
import { useAuthStore } from '@/stores/auth.store';

const ASSIGNEE_FILTERS: AssigneeFilter[] = [null, 'me', 'unassigned'];

/**
 * Debounce a fast-changing value (e.g. the search box) so it only settles
 * after `delay` ms of quiet. Keeps the input responsive while collapsing a
 * burst of keystrokes into a single downstream query.
 */
function useDebounced<T>(value: T, delay = 280): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(id);
  }, [value, delay]);
  return debounced;
}

function assigneeStorageKey(userId?: string): string {
  return userId ? `picoa-inbox-assignee:${userId}` : 'picoa-inbox-assignee';
}

function readStoredAssignee(userId?: string): AssigneeFilter {
  try {
    const raw = localStorage.getItem(assigneeStorageKey(userId));
    if (raw === 'me' || raw === 'unassigned') return raw;
    return null;
  } catch {
    return null;
  }
}

export function ConversationsList({ activeId }: { activeId?: string }) {
  const userId = useAuthStore((s) => s.user?.id);
  const [filter, setFilter] = useState<'all' | 'unread' | 'awaiting'>('all');
  const [search, setSearch] = useState('');
  // Debounce so a burst of keystrokes fires one request instead of one/key.
  const debouncedSearch = useDebounced(search);
  const [instanceId, setInstanceId] = useState<string | null>(null);
  const [assignee, setAssignee] = useState<AssigneeFilter>(() => readStoredAssignee(userId));
  const navigate = useNavigate();

  // Provider filter (multi-provider channels — F4b): the initial value comes
  // from the global provider scope (topbar selector), but changing it here is
  // purely local — it does NOT call the global setScope, so the operator can
  // narrow the inbox to one provider without re-scoping the rest of the app.
  // Applied server-side (passed to useConversations below) instead of
  // filtering client-side over an already-paginated page: with Evolution at
  // high volume and Twilio in warm-up (low volume), a client-side filter over
  // just the first page could show "no conversations" for Twilio even though
  // matches exist further down — see chat.repository.ts (backend) for the
  // where.instance.provider filter this now drives.
  const { scope } = useProviderScope();
  const [providerFilter, setProviderFilter] = useState<ProviderScope>(scope);
  // Pedido do cliente (2026-08-25): GOZAP é o canal padrão do inbox. Sem uma
  // preferência EXPLÍCITA já escolhida no escopo global (topbar) — isto é,
  // com `scope === 'all'` — a aba pré-seleciona GOZAP sozinha assim que a
  // lista de provedores carrega. Um `scope` explícito (ex.: o operador já
  // fixou EVOLUTION no topbar) nunca é sobrescrito por este default local, e
  // o efeito só age UMA VEZ (o ref trava depois do primeiro veredito) — não
  // reimpõe GOZAP se o operador trocar de aba na sequência.
  const gozapDefaultedRef = useRef(false);

  // Persist the selected assignee tab so an operator returns to their view.
  useEffect(() => {
    try { localStorage.setItem(assigneeStorageKey(userId), assignee ?? ''); } catch { /* storage unavailable */ }
  }, [assignee, userId]);

  function selectAssignee(next: AssigneeFilter) {
    setAssignee(ASSIGNEE_FILTERS.includes(next) ? next : null);
  }
  const instancesQuery = useInstances();
  const providersQuery = useProviders();
  useEffect(() => {
    if (gozapDefaultedRef.current || scope !== 'all') return;
    const hasGozap = (providersQuery.data?.providers ?? []).some((p) => p.provider === 'GOZAP');
    if (!hasGozap) return;
    gozapDefaultedRef.current = true;
    setProviderFilter('GOZAP');
  }, [scope, providersQuery.data]);
  const connected = (instancesQuery.data ?? [])
    .filter((i) => i.lastConnectionState === 'open')
    .map((i) => ({ id: i.id, name: i.name }));
  // T7 (twilio-platform): canais não-Evolution não têm estado de conexão
  // Evolution — não existe 'open' para filtrar. Todo canal ATIVO fora do
  // Evolution entra na barra de abas "número" junto dos Evolution conectados.
  // O dot da aba é cor de identidade (instanceColor), não indicador de
  // conexão, então vale igual para eles. GET /whatsapp/instances é
  // Evolution-only no backend, por isso os demais canais vêm de useProviders().
  //
  // O filtro é `provider !== 'EVOLUTION'`, NÃO `!traits.sessionBased`: GOZAP
  // também é session-based (par pairing por QR, como o Evolution) mas não
  // tem NENHUMA outra fonte de canal — filtrar por sessionBased o descartava
  // por inteiro, deixando a barra de abas e o badge cegos para GOZAP.
  // Pedido do cliente (2026-08-25): TWILIO nunca aparece na barra de número
  // do inbox — mesma exclusão do ProviderTabs (provider-tabs.tsx). O enum do
  // provider continua intacto; só a oferta na UI some.
  const cloudChannels = (providersQuery.data?.providers ?? [])
    .filter((p) => p.provider !== 'EVOLUTION' && p.provider !== 'TWILIO')
    .flatMap((p) => p.channels)
    .filter((c) => c.isActive)
    .map((c) => ({ id: c.id, name: c.name }));
  const channels = [...connected, ...cloudChannels];
  const showBadge = instanceId === null && channels.length >= 2;
  // If the number behind the active tab disconnects (or is removed), the tab
  // bar hides but the list would stay silently filtered to a gone instance.
  // Fall back to "Todos" so the operator never gets a stuck empty list.
  // Canais cloud contam como sempre-presentes enquanto ativos (nunca são
  // "desconectados" — só somem se desativados).
  const channelsKey = channels.map((c) => c.id).join(',');
  useEffect(() => {
    if (instanceId !== null && !channels.some((c) => c.id === instanceId)) {
      setInstanceId(null);
    }
    // channelsKey is a stable signal for the visible-channel-id set.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelsKey, instanceId]);
  const { data, isLoading, isError, error, refetch, fetchNextPage, hasNextPage, isFetchingNextPage } = useConversations(
    filter,
    debouncedSearch,
    instanceId ?? undefined,
    assignee ?? undefined,
    providerFilter === 'all' ? undefined : providerFilter,
  );

  const items = data?.items ?? [];
  const total = data?.total ?? 0;

  // Scroll infinito: o botão "Carregar mais" é o sentinela — quando ele entra
  // na área visível, a próxima página é buscada sozinha. O botão continua
  // clicável de propósito: é o fallback acessível (e o que os testes em jsdom,
  // que não tem IntersectionObserver, conseguem exercitar).
  //
  // O elemento vive em STATE (callback ref), não em useRef: o botão desmonta
  // e remonta (ex.: um blip de rede põe a query em erro → fallback → retry →
  // lista de volta) SEM que hasNextPage/fetchNextPage mudem — um useRef não
  // re-executaria o effect e o observer ficaria preso ao nó antigo, morto: o
  // scroll infinito pararia em silêncio até um F5.
  const [loadMoreEl, setLoadMoreEl] = useState<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!loadMoreEl || !hasNextPage || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) fetchNextPage();
      },
      // Antecipa o fetch um pouco antes de o botão aparecer — o operador
      // rolando rápido não esbarra num fundo vazio.
      { rootMargin: '160px' },
    );
    observer.observe(loadMoreEl);
    return () => observer.disconnect();
  }, [loadMoreEl, hasNextPage, fetchNextPage]);
  // Badge visibility: once the provider filter narrows the list server-side,
  // every row already shares the same provider — the badge would be pure
  // noise, so it only shows on the unfiltered ('all') view when the loaded
  // page actually mixes 2+ providers. With a single provider configured
  // overall the filter itself never mounts (see ProviderTabs).
  const showProviderBadge = providerFilter === 'all' && new Set(items.map((c) => c.provider).filter(Boolean)).size >= 2;

  return (
    <div className="flex h-full flex-col" style={{ borderRight: '1px solid var(--border)' }}>
      <div className="space-y-2 px-3.5 py-3" style={{ borderBottom: '1px solid var(--border)' }}>
        <div className="ds-eyebrow">inbox</div>
        <div className="flex items-center gap-1.5">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar conversa…"
            className="w-full min-w-0 flex-1 rounded-md px-3 py-1.5 text-sm"
            style={{ background: 'var(--surface-sunken)' }}
          />
          <button
            type="button"
            aria-pressed={filter === 'unread'}
            onClick={() => setFilter(filter === 'unread' ? 'all' : 'unread')}
            className="shrink-0 rounded-full px-2.5 py-1 text-xs"
            style={{
              background: filter === 'unread' ? 'var(--st-read-bg)' : 'transparent',
              color: filter === 'unread' ? 'var(--brand-purple)' : 'var(--foreground-muted)',
            }}
          >
            Não lidas
          </button>
          {/* "Aguardando resposta": o CONTATO falou por último e ninguém
              respondeu ainda (lastMessageDirection === 'INBOUND' no backend).
              Mutuamente exclusivo com "Não lidas" — `filter` é um único valor. */}
          <button
            type="button"
            aria-pressed={filter === 'awaiting'}
            onClick={() => setFilter(filter === 'awaiting' ? 'all' : 'awaiting')}
            className="shrink-0 rounded-full px-2.5 py-1 text-xs"
            style={{
              background: filter === 'awaiting' ? 'var(--st-read-bg)' : 'transparent',
              color: filter === 'awaiting' ? 'var(--brand-purple)' : 'var(--foreground-muted)',
            }}
          >
            Aguardando resposta
          </button>
        </div>
        <AssigneeTabs value={assignee} onChange={selectAssignee} />
        <InboxTabs instances={channels} value={instanceId} onChange={setInstanceId} />
        <ProviderTabs value={providerFilter} onChange={setProviderFilter} />
      </div>
      {/* `min-h-0`: um filho flex tem `min-height: auto`, que o proíbe de
          encolher abaixo do conteúdo — ele cresceria até caber as 138 conversas
          e o `overflow-y-auto` nunca teria o que rolar. */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {isError ? (
          <div className="p-3"><QueryErrorFallback error={error} onRetry={() => refetch()} /></div>
        ) : isLoading ? (
          <p className="p-4 text-sm" style={{ color: 'var(--foreground-muted)' }}>Carregando…</p>
        ) : items.length > 0 ? (
          <>
            {items.map((c) => (
              <ConversationRow key={c.id} c={c} active={c.id === activeId} showInstanceBadge={showBadge} showProviderBadge={showProviderBadge} onClick={() => navigate({ to: '/inbox/$conversationId', params: { conversationId: c.id } })} />
            ))}
            {hasNextPage && (
              <button
                type="button"
                ref={setLoadMoreEl}
                onClick={() => fetchNextPage()}
                disabled={isFetchingNextPage}
                className="w-full px-4 py-3 text-center text-xs"
                style={{ color: 'var(--foreground-muted)' }}
              >
                {isFetchingNextPage ? 'Carregando mais…' : `Carregar mais · ${items.length} de ${total}`}
              </button>
            )}
          </>
        ) : providerFilter !== 'all' ? (
          <p className="p-4 text-sm" style={{ color: 'var(--foreground-muted)' }}>Nenhuma conversa deste provedor.</p>
        ) : (
          <p className="p-4 text-sm" style={{ color: 'var(--foreground-muted)' }}>Nenhuma conversa ainda.</p>
        )}
      </div>
    </div>
  );
}
