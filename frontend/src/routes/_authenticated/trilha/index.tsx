import { useState, type FormEvent } from 'react';
import { createFileRoute, redirect } from '@tanstack/react-router';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { QueryErrorFallback } from '@/components/query-error-fallback';
import { useAuthStore } from '@/stores/auth.store';
import { canQueryAuditTrailUi } from '@/features/people-record/ui-policy';
import { useAuditTrail, type AuditTrailQuery } from '@/features/audit-trail/api';
import { categoryLabel } from '@/features/audit-trail/labels';
import { AUDIT_CATEGORIES, type AuditCategory } from '@/features/audit-trail/schemas';
import { TrailTable } from '@/features/audit-trail/components/trail-table';

const route = createFileRoute('/_authenticated/trilha/')({
  beforeLoad: () => {
    const { user } = useAuthStore.getState();
    if (!user || !canQueryAuditTrailUi(user.role)) {
      throw redirect({ to: '/dashboard' });
    }
  },
  component: TrailPage,
});
export { route as Route };

const PAGE_SIZE = 20;

type Filters = { q: string; from: string; to: string; category: AuditCategory | '' };
const NO_FILTERS: Filters = { q: '', from: '', to: '', category: '' };

function toQuery(filters: Filters, page: number): AuditTrailQuery {
  return {
    q: filters.q.trim() || undefined,
    from: filters.from || undefined,
    to: filters.to || undefined,
    category: filters.category || undefined,
    page,
    pageSize: PAGE_SIZE,
  };
}

function TrailFilters({ onApply }: { onApply: (filters: Filters) => void }) {
  const [draft, setDraft] = useState<Filters>(NO_FILTERS);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onApply(draft);
  };
  const clear = () => {
    setDraft(NO_FILTERS);
    onApply(NO_FILTERS);
  };
  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
      <div className="space-y-1">
        <Label htmlFor="trail-q">Pessoa (nome ou matrícula)</Label>
        <Input id="trail-q" className="w-64" maxLength={80} value={draft.q} onChange={(e) => setDraft({ ...draft, q: e.target.value })} />
      </div>
      <div className="space-y-1">
        <Label htmlFor="trail-from">De</Label>
        <Input id="trail-from" type="date" max={draft.to || undefined} value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })} />
      </div>
      <div className="space-y-1">
        <Label htmlFor="trail-to">Até</Label>
        <Input id="trail-to" type="date" min={draft.from || undefined} value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} />
      </div>
      <div className="space-y-1">
        <Label htmlFor="trail-category">Tipo</Label>
        <select id="trail-category" className="h-9 rounded-lg border bg-card px-2 text-sm" value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value as AuditCategory | '' })}>
          <option value="">Todos os tipos</option>
          {AUDIT_CATEGORIES.map((category) => <option key={category} value={category}>{categoryLabel(category)}</option>)}
        </select>
      </div>
      <Button type="submit">Filtrar</Button>
      <Button type="button" variant="outline" onClick={clear}>Limpar</Button>
    </form>
  );
}

type PagerProps = { page: number; total: number; pageSize: number; onPage: (page: number) => void };

function TrailPager({ page, total, pageSize, onPage }: PagerProps) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="flex items-center justify-end gap-3 text-sm">
      <span>{`Página ${page} de ${pages}`}</span>
      <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>Anterior</Button>
      <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>Próxima</Button>
    </div>
  );
}

function TrailPage() {
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [page, setPage] = useState(1);
  const { data, isLoading, isError, error, refetch } = useAuditTrail(toQuery(filters, page));
  const apply = (next: Filters) => {
    setFilters(next);
    setPage(1);
  };
  return (
    <div className="p-8 space-y-6">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.14em]" style={{ color: 'var(--foreground-muted)' }}>Administração / auditoria</p>
        <h1 className="text-2xl font-bold">Trilha de alterações</h1>
        <p className="text-sm" style={{ color: 'var(--foreground-muted)' }}>Quem alterou o quê, quando e por quê. Os mais recentes aparecem primeiro.</p>
      </div>
      <TrailFilters onApply={apply} />
      {isLoading && <Skeleton className="h-40 w-full" />}
      {isError && <QueryErrorFallback error={error} onRetry={refetch} />}
      {data && (
        <>
          <TrailTable entries={data.items} showSubject />
          <TrailPager page={page} total={data.total} pageSize={PAGE_SIZE} onPage={setPage} />
        </>
      )}
    </div>
  );
}
