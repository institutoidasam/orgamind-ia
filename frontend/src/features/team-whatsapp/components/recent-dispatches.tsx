import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Pagination } from '@/features/internal-communications/components/pagination';
import { formatDatePtBr } from '@/lib/format-date-ptbr';
import { useTeamDispatches } from '../api';
import { activityText } from '../activity-text';
import { channelLabel, countParts } from '../error-messages';
import {
  BASE_LABEL, DISPATCH_STATE_LABEL, dispatchSituation, LEGACY_BASE_LABEL, PURPOSE_LABEL,
} from '../labels';
import type { DispatchList, DispatchListFilters, Paging, TeamDispatchState, TeamPurpose } from '../schemas';
import { useBackToLastPage } from '../use-back-to-last-page';
import { PagedError } from './paged-error';

type Item = DispatchList['items'][number];
type Counts = Item['counts'];

/** Só as situações com alguém: `Na fila 1 · Aceito pelo WhatsApp 3 · Lido 1`. */
function countsText(counts: Counts): string {
  return countParts(counts).map(({ label, count }) => `${label} ${count}`).join(' · ');
}

/** Situação exibida (DG9, DG16): o envio normal fica sem selo, com as contagens; o resto leva o texto. */
function StateBadge({ item }: { item: Item }) {
  const situation = dispatchSituation(item, new Date());
  if (situation === DISPATCH_STATE_LABEL.DISPATCHED) return null;
  return <p className="font-medium">{situation}</p>;
}

type Channel = Item['channels'][number];

function ChannelsCell({ channels }: { channels: Channel[] }) {
  if (channels.length === 0) return <>—</>;
  const several = channels.length > 1;
  return (
    <>
      {channels.map((c, index) => (
        <p key={`${index}:${c.phoneE164 ?? c.name}`}>{channelLabel(c, several ? c.count : null)}</p>
      ))}
    </>
  );
}

/**
 * Finalidade, base e atividade; envio a setor anterior à finalidade: `—` e a regra anterior (C5). Envio a uma
 * pessoa não tem finalidade nem base (não muda nesta etapa): a célula fica vazia, como o histórico sempre o mostrou.
 */
function PurposeCell({ item }: { item: Item }) {
  if (item.target.type === 'user') return null;
  const activity = activityText(item.activity);
  return (
    <>
      <p className="font-medium">{item.purpose ? PURPOSE_LABEL[item.purpose] : '—'}</p>
      <p className="text-muted-foreground">{item.base ? BASE_LABEL[item.base] : LEGACY_BASE_LABEL}</p>
      {activity && <p>{activity}</p>}
    </>
  );
}

function DispatchRow({ item }: { item: Item }) {
  return (
    <TableRow>
      <TableCell>{new Date(item.createdAt).toLocaleString('pt-BR')}</TableCell>
      <TableCell>{item.author?.name ?? item.author?.email ?? '—'}</TableCell>
      <TableCell>{item.target.label}</TableCell>
      <TableCell className="text-sm"><PurposeCell item={item} /></TableCell>
      <TableCell><ChannelsCell channels={item.channels} /></TableCell>
      <TableCell className="text-sm">
        <StateBadge item={item} />
        {countsText(item.counts)}
        <Link className="mt-1 block underline" to="/whatsapp-equipe/$dispatchId" params={{ dispatchId: item.id }}>
          Ver resultado
        </Link>
      </TableCell>
      <TableCell>{item.rosterDate ? formatDatePtBr(item.rosterDate) : '—'}</TableCell>
    </TableRow>
  );
}

type ListProps = { items: Item[]; paging: Paging; filtered?: boolean };

/** Uma página do histórico; a paginação só aparece com mais de uma página. */
export function RecentDispatches({ items, paging, filtered = false }: ListProps) {
  if (items.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {filtered ? 'Nenhum envio encontrado com esses filtros.' : 'Nenhum envio ainda.'}
      </p>
    );
  }
  return (
    <div className="space-y-3">
      <div className="rounded-md border" style={{ borderColor: 'var(--border)' }}>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Data</TableHead><TableHead>Autor</TableHead><TableHead>Destino</TableHead>
              <TableHead>Finalidade</TableHead><TableHead>Número</TableHead><TableHead>Situação</TableHead>
              <TableHead>Data de referência</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>{items.map((i) => <DispatchRow key={i.id} item={i} />)}</TableBody>
        </Table>
      </div>
      {paging.total > paging.pageSize && <Pagination {...paging} />}
    </div>
  );
}

const ALL = 'all';
const PURPOSES = Object.keys(PURPOSE_LABEL) as TeamPurpose[];
/** Ordem do filtro "Situação": o estado gravado (DG9, DG14); "Não enviado" é o `EXPIRED`. */
const STATES: TeamDispatchState[] = ['SCHEDULED', 'DISPATCHED', 'CANCELLED', 'EXPIRED'];

type FilterSelectProps<T extends string> = {
  id: string;
  label: string;
  value: T | undefined;
  options: readonly T[];
  names: Record<T, string>;
  onChange: (value: T | undefined) => void;
};

/** O nome acessível leva "Filtrar por": a tela de envio da mesma página também tem um campo "Finalidade". */
function FilterSelect<T extends string>({ id, label, value, options, names, onChange }: FilterSelectProps<T>) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <Select value={value ?? ALL} onValueChange={(next) => onChange(next === ALL ? undefined : (next as T))}>
        <SelectTrigger id={id} aria-label={`Filtrar por ${label.toLowerCase()}`}><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>Todas</SelectItem>
          {options.map((option) => <SelectItem key={option} value={option}>{names[option]}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
  );
}

type DateFilterProps = { id: string; label: string; value: string; min?: string; max?: string; onChange: (value: string) => void };

function DateFilter({ id, label, value, min, max, onChange }: DateFilterProps) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} type="date" value={value} min={min} max={max} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

type FiltersProps = { value: DispatchListFilters; onChange: (next: DispatchListFilters) => void };

const INVERTED_PERIOD_TEXT = 'A data inicial é depois da data final.';

/** "De" depois de "Até" (datas `AAAA-MM-DD`, que ordenam como texto): o servidor não recebe esse período. */
const isInverted = ({ from, to }: DispatchListFilters): boolean => Boolean(from && to && from > to);

/** Controles acima da tabela (G5): período da criação, finalidade e situação gravada; mudar um volta à página 1. */
function DispatchFilters({ value, onChange }: FiltersProps) {
  const set = (patch: Partial<DispatchListFilters>) =>
    onChange(Object.fromEntries(Object.entries({ ...value, ...patch }).filter(([, filled]) => filled)));
  return (
    <div className="space-y-1">
      <div role="group" aria-label="Filtros do histórico" className="flex flex-wrap items-end gap-3">
        <DateFilter id="dispatch-filter-from" label="De" value={value.from ?? ''} max={value.to} onChange={(from) => set({ from })} />
        <DateFilter id="dispatch-filter-to" label="Até" value={value.to ?? ''} min={value.from} onChange={(to) => set({ to })} />
        <FilterSelect
          id="dispatch-filter-purpose" label="Finalidade" value={value.purpose} options={PURPOSES}
          names={PURPOSE_LABEL} onChange={(purpose) => set({ purpose })}
        />
        <FilterSelect
          id="dispatch-filter-state" label="Situação" value={value.state} options={STATES}
          names={DISPATCH_STATE_LABEL} onChange={(state) => set({ state })}
        />
        <Button variant="outline" onClick={() => onChange({})}>Limpar filtros</Button>
      </div>
      {isInverted(value) && <p role="alert" className="text-sm text-destructive">{INVERTED_PERIOD_TEXT}</p>}
    </div>
  );
}

/** Seção "Envios recentes": filtros, página e lista; filtro novo sempre volta à página 1. */
export function RecentHistory() {
  const [page, setPage] = useState(1);
  // `filters` é o que está nos campos; `applied`, o último período válido, o único que vai ao servidor.
  const [filters, setFilters] = useState<DispatchListFilters>({});
  const [applied, setApplied] = useState<DispatchListFilters>({});
  const dispatches = useTeamDispatches(page, applied);
  useBackToLastPage(page, setPage, dispatches.data);
  const { data } = dispatches;
  const change = (next: DispatchListFilters) => {
    setFilters(next);
    if (isInverted(next)) return;
    setApplied(next);
    setPage(1);
  };
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">Envios recentes</h2>
      <DispatchFilters value={filters} onChange={change} />
      {dispatches.isError && (
        <PagedError error={dispatches.error} onRetry={dispatches.refetch} page={page} onFirstPage={() => setPage(1)} />
      )}
      {data && (
        <RecentDispatches
          items={data.items} filtered={Object.keys(applied).length > 0}
          paging={{ page, pageSize: data.pageSize, total: data.total, onPageChange: setPage }}
        />
      )}
    </section>
  );
}
