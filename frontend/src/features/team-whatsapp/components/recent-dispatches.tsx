import { Link } from '@tanstack/react-router';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Pagination } from '@/features/internal-communications/components/pagination';
import { channelLabel, countParts } from '../error-messages';
import type { DispatchList, Paging } from '../schemas';

type Item = DispatchList['items'][number];
type Counts = Item['counts'];

/** Só as situações com alguém: `Na fila 1 · Aceito pelo WhatsApp 3 · Lido 1`. */
function countsText(counts: Counts): string {
  return countParts(counts).map(({ label, count }) => `${label} ${count}`).join(' · ');
}

const STATE_LABEL = { SCHEDULED: 'Agendado', CANCELLED: 'Cancelado' } as const;

function StateBadge({ state }: { state: Item['state'] }) {
  if (state === 'DISPATCHED') return null;
  return <p className="font-medium">{STATE_LABEL[state]}</p>;
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

function DispatchRow({ item }: { item: Item }) {
  return (
    <TableRow>
      <TableCell>{new Date(item.createdAt).toLocaleString('pt-BR')}</TableCell>
      <TableCell>{item.author?.name ?? item.author?.email ?? '—'}</TableCell>
      <TableCell>{item.target.label}</TableCell>
      <TableCell><ChannelsCell channels={item.channels} /></TableCell>
      <TableCell className="text-sm">
        <StateBadge state={item.state} />
        {countsText(item.counts)}
        <Link className="mt-1 block underline" to="/whatsapp-equipe/$dispatchId" params={{ dispatchId: item.id }}>
          Ver resultado
        </Link>
      </TableCell>
    </TableRow>
  );
}

/** Uma página do histórico; a paginação só aparece com mais de uma página. */
export function RecentDispatches({ items, paging }: { items: Item[]; paging: Paging }) {
  if (items.length === 0) {
    return <p className="text-sm text-muted-foreground">Nenhum envio ainda.</p>;
  }
  return (
    <div className="space-y-3">
      <div className="rounded-md border" style={{ borderColor: 'var(--border)' }}>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Data</TableHead><TableHead>Autor</TableHead><TableHead>Destino</TableHead>
              <TableHead>Número</TableHead><TableHead>Situação</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>{items.map((i) => <DispatchRow key={i.id} item={i} />)}</TableBody>
        </Table>
      </div>
      {paging.total > paging.pageSize && <Pagination {...paging} />}
    </div>
  );
}
