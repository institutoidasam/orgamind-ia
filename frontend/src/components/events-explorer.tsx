import { useMemo, useState } from 'react';
import { useCampaignMessages } from '@/features/campaigns/api';
import { EventsList } from './events-list';
import { EventDetail } from './event-detail';
import type { CampaignMessage, MessageStatus } from '@/features/campaigns/schemas';

const PAGE_SIZE = 50;

type Filter = 'all' | 'READ' | 'DELIVERED' | 'FAILED';

const FILTERS: Filter[] = ['all', 'READ', 'DELIVERED', 'FAILED'];

const FILTER_LABEL: Record<Filter, string> = {
  all: 'Todos',
  READ: 'Lidas',
  DELIVERED: 'Entregues',
  FAILED: 'Falhas',
};

type StatusCount = { status: string; _count: number };

type EventsExplorerProps = {
  campaignId: string;
  live?: boolean;
  // Authoritative per-status aggregate for the whole campaign. Required: the
  // filter tab counts are campaign-wide totals and cannot be derived from a
  // single (paginated) page of messages. CampaignDetail always provides it.
  statusCounts: StatusCount[];
};

type ExplorerQuery = EventsExplorerProps & {
  filter: Filter;
  page: number;
};

/**
 * Resolves the campaign-wide count shown on a filter tab from the authoritative
 * `statusCounts` aggregate — never the visible (paginated) page. "all" is the
 * sum across statuses, falling back to `totalAll` when the per-status lookup
 * has nothing to add. Pure: same inputs → same number.
 */
function filterCount(
  f: Filter,
  counts: Map<string, number>,
  totalAll: number,
): number {
  return f === 'all' ? totalAll : (counts.get(f) ?? 0);
}

function FilterTab({
  filter,
  isActive,
  count,
  onSelect,
}: {
  filter: Filter;
  isActive: boolean;
  count: number;
  onSelect: (f: Filter) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(filter)}
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium"
      style={{
        background: isActive ? 'var(--brand-blue-soft)' : 'transparent',
        color: isActive ? 'var(--brand-blue)' : 'var(--foreground-muted)',
        border: `1px solid ${isActive ? 'var(--brand-blue)' : 'var(--border)'}`,
      }}
    >
      {FILTER_LABEL[filter]}
      <span className="ds-mono text-[11px]">{count}</span>
    </button>
  );
}

function EventsPager({
  page,
  totalPages,
  total,
  onPrev,
  onNext,
}: {
  page: number;
  totalPages: number;
  total: number;
  onPrev: () => void;
  onNext: () => void;
}) {
  return (
    <div
      className="flex items-center justify-between border-t px-3 py-2 text-xs"
      style={{ borderColor: 'var(--border)', color: 'var(--foreground-muted)' }}
    >
      <span>
        Página {page} de {totalPages} · {total} no total
      </span>
      <div className="flex gap-1">
        <button
          type="button"
          disabled={page <= 1}
          onClick={onPrev}
          className="rounded px-2 py-1 disabled:opacity-40 hover:bg-[var(--surface-hover)]"
        >
          ‹
        </button>
        <button
          type="button"
          disabled={page >= totalPages}
          onClick={onNext}
          className="rounded px-2 py-1 disabled:opacity-40 hover:bg-[var(--surface-hover)]"
        >
          ›
        </button>
      </div>
    </div>
  );
}

function LiveIndicator() {
  return (
    <span
      className="ml-auto inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px]"
      style={{
        background: 'var(--st-read-bg)',
        color: 'var(--st-read-fg)',
        border: '1px solid var(--st-read-border)',
      }}
    >
      <span
        className="inline-block size-1.5 animate-pulse rounded-full"
        style={{ background: 'var(--st-read-fg)' }}
      />
      ao vivo
    </span>
  );
}

function EventsFilters({
  filter,
  counts,
  total,
  live,
  onSelect,
}: {
  filter: Filter;
  counts: Map<string, number>;
  total: number;
  live?: boolean;
  onSelect: (filter: Filter) => void;
}) {
  return (
    <div
      className="flex flex-wrap items-center gap-2 border-b p-3"
      style={{ borderColor: 'var(--border)' }}
    >
      {FILTERS.map((currentFilter) => (
        <FilterTab
          key={currentFilter}
          filter={currentFilter}
          isActive={currentFilter === filter}
          count={filterCount(currentFilter, counts, total)}
          onSelect={onSelect}
        />
      ))}
      {live && <LiveIndicator />}
    </div>
  );
}

type EventsListPanelProps = {
  filter: Filter;
  counts: Map<string, number>;
  totalAll: number;
  total: number;
  live?: boolean;
  messages: CampaignMessage[];
  activeId: string | null;
  page: number;
  totalPages: number;
  onFilterSelect: (filter: Filter) => void;
  onActive: (id: string) => void;
  onPrev: () => void;
  onNext: () => void;
};

function EventsListPanel({
  filter,
  counts,
  totalAll,
  total,
  live,
  messages,
  activeId,
  page,
  totalPages,
  onFilterSelect,
  onActive,
  onPrev,
  onNext,
}: EventsListPanelProps) {
  return (
    <div className="border-r" style={{ borderColor: 'var(--border)' }}>
      <EventsFilters
        filter={filter}
        counts={counts}
        total={totalAll}
        live={live}
        onSelect={onFilterSelect}
      />
      <div className="max-h-[600px] overflow-y-auto">
        <EventsList messages={messages} activeId={activeId} onActive={onActive} />
      </div>
      {totalPages > 1 && (
        <EventsPager
          page={page}
          totalPages={totalPages}
          total={total}
          onPrev={onPrev}
          onNext={onNext}
        />
      )}
    </div>
  );
}

function useExplorerData({
  campaignId,
  filter,
  page,
  live,
  statusCounts,
}: ExplorerQuery) {
  const status: MessageStatus | undefined =
    filter === 'all' ? undefined : (filter as MessageStatus);
  const { data } = useCampaignMessages(
    campaignId,
    {
      page,
      pageSize: PAGE_SIZE,
      status,
    },
    { live },
  );
  const messages = data?.items ?? [];
  const total = data?.total ?? 0;
  // Precompute the per-status lookup once so each filter tab is an O(1) read
  // instead of re-scanning statusCounts on every render.
  const counts = useMemo(
    () => new Map((statusCounts ?? []).map((c) => [c.status, c._count])),
    [statusCounts],
  );
  // Campaign-wide total across all statuses. Falls back to the page `total`
  // (also a campaign-wide count from the API) if a cast/stale response ever
  // delivers an empty statusCounts — never to the visible page length, which
  // would understate a multi-page campaign.
  const totalAll = statusCounts?.length
    ? statusCounts.reduce((acc, c) => acc + c._count, 0)
    : total;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  return { counts, messages, total, totalAll, totalPages };
}

function EventsExplorerLayout({
  campaignId,
  active,
  panel,
}: {
  campaignId: string;
  active: CampaignMessage | null;
  panel: EventsListPanelProps;
}) {
  return (
    <div
      className="grid overflow-hidden rounded-xl border"
      style={{ borderColor: 'var(--border)', background: 'var(--surface)', gridTemplateColumns: 'minmax(280px, 360px) 1fr' }}
    >
      <EventsListPanel {...panel} />
      <EventDetail campaignId={campaignId} message={active} />
    </div>
  );
}

export function EventsExplorer({ campaignId, live, statusCounts }: EventsExplorerProps) {
  const [filter, setFilter] = useState<Filter>('all');
  const [activeId, setActiveId] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const { counts, messages, total, totalAll, totalPages } = useExplorerData({
    campaignId,
    filter,
    page,
    live,
    statusCounts,
  });
  const active = messages.find((message) => message.id === activeId) ?? messages[0] ?? null;

  function selectFilter(nextFilter: Filter) {
    // Changing the filter must start from the first page, so a previous page
    // index cannot point beyond the filtered result set.
    setFilter(nextFilter);
    setPage(1);
  }

  return <EventsExplorerLayout campaignId={campaignId} active={active} panel={{
    filter,
    counts,
    totalAll,
    total,
    live,
    messages,
    activeId: active?.id ?? null,
    page,
    totalPages,
    onFilterSelect: selectFilter,
    onActive: setActiveId,
    onPrev: () => setPage((currentPage) => Math.max(1, currentPage - 1)),
    onNext: () => setPage((currentPage) => currentPage + 1),
  }} />;
}
