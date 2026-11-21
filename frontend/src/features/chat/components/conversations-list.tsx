import { useEffect, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useConversationList } from '../api';
import { ConversationRow } from './conversation-row';
import { QueryErrorFallback } from '@/components/query-error-fallback';
import { InboxTabs } from './inbox-tabs';
import { AssigneeTabs, type AssigneeFilter } from './assignee-tabs';
import { ConversationStatusFilter } from './conversation-status-filter';
import { ShiftHandoverHeader } from './shift-handover-dialog';
import { assigneeForStatus, type ConversationStatusFilterValue } from './conversation-status';
import { useInstances } from '@/features/whatsapp/api';
import { useAuthStore } from '@/stores/auth.store';

const ASSIGNEE_FILTERS: AssigneeFilter[] = [null, 'me', 'unassigned', 'handover'];

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
    if (raw === 'me' || raw === 'unassigned' || raw === 'handover') return raw;
    return null;
  } catch {
    return null;
  }
}

export function ConversationsList({ activeId }: { activeId?: string }) {
  const userId = useAuthStore((s) => s.user?.id);
  const [filter, setFilter] = useState<'all' | 'unread' | 'awaiting'>('all');
  const [status, setStatus] = useState<ConversationStatusFilterValue>('open');
  const [search, setSearch] = useState('');
  // Debounce so a burst of keystrokes fires one request instead of one/key.
  const debouncedSearch = useDebounced(search);
  const [instanceId, setInstanceId] = useState<string | null>(null);
  const [assignee, setAssignee] = useState<AssigneeFilter>(() => readStoredAssignee(userId));
  const navigate = useNavigate();

  // Persist the selected assignee tab so an operator returns to their view.
  useEffect(() => {
    try { localStorage.setItem(assigneeStorageKey(userId), assignee ?? ''); } catch { /* storage unavailable */ }
  }, [assignee, userId]);

  function selectAssignee(next: AssigneeFilter) {
    setAssignee(ASSIGNEE_FILTERS.includes(next) ? next : null);
  }
  const instancesQuery = useInstances();
  // Só números Evolution conectados entram na barra de abas "número": é o único
  // provedor ligado (R14); canais de integrações desligadas não são oferecidos.
  const channels = (instancesQuery.data ?? [])
    .filter((i) => i.lastConnectionState === 'open')
    .map((i) => ({ id: i.id, name: i.name }));
  const showBadge = instanceId === null && channels.length >= 2;
  // If the number behind the active tab disconnects (or is removed), the tab
  // bar hides but the list would stay silently filtered to a gone instance.
  // Fall back to "Todos" so the operator never gets a stuck empty list.
  const channelsKey = channels.map((c) => c.id).join(',');
  useEffect(() => {
    if (instanceId !== null && !channels.some((c) => c.id === instanceId)) {
      setInstanceId(null);
    }
    // channelsKey is a stable signal for the visible-channel-id set.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelsKey, instanceId]);
  const { data, isLoading, isError, error, refetch, fetchNextPage, hasNextPage, isFetchingNextPage } = useConversationList({
    filter, search: debouncedSearch, status,
    instanceId: instanceId ?? undefined, assignee: assigneeForStatus(status, assignee),
  });

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
  // O badge de provedor por linha fica: o histórico é misto (conversas de
  // números hoje desligados convivem com as da Evolution) e o badge ajuda a
  // ler a origem. Só aparece quando a página carregada mistura 2+ provedores.
  const showProviderBadge = new Set(items.map((c) => c.provider).filter(Boolean)).size >= 2;

  return (
    <div className="flex h-full flex-col" style={{ background: 'var(--surface)', borderRight: '1px solid var(--border)' }}>
      <div className="space-y-2 px-3.5 py-3" style={{ borderBottom: '1px solid var(--border)' }}>
        <ShiftHandoverHeader />
        <div className="flex items-center gap-1.5">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar conversa…"
            className="w-full min-w-0 flex-1 rounded-md px-3 py-1.5 text-sm"
            style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
          />
          <button
            type="button"
            aria-pressed={filter === 'unread'}
            onClick={() => setFilter(filter === 'unread' ? 'all' : 'unread')}
            className="shrink-0 rounded-full px-2.5 py-1 text-xs"
            style={{
              background: filter === 'unread' ? 'var(--brand-orange-soft)' : 'transparent',
              color: filter === 'unread' ? 'var(--brand-orange-text)' : 'var(--foreground-muted)',
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
              background: filter === 'awaiting' ? 'var(--brand-orange-soft)' : 'transparent',
              color: filter === 'awaiting' ? 'var(--brand-orange-text)' : 'var(--foreground-muted)',
            }}
          >
            Aguardando resposta
          </button>
        </div>
        <ConversationStatusFilter value={status} onChange={setStatus} />
        {status === 'open' && <AssigneeTabs value={assignee} onChange={selectAssignee} />}
        <InboxTabs instances={channels} value={instanceId} onChange={setInstanceId} />
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
        ) : (
          <p className="p-4 text-sm" style={{ color: 'var(--foreground-muted)' }}>Nenhuma conversa ainda.</p>
        )}
      </div>
    </div>
  );
}
