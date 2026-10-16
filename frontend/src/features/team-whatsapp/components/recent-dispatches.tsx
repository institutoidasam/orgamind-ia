import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import type { DispatchList } from '../schemas';

type Item = DispatchList['items'][number];

function countsText({ queued, sent, failed, skipped }: Item['counts']): string {
  return `Enfileirados ${queued} · Enviados ${sent} · Falhas ${failed} · Pulados ${skipped}`;
}

function DispatchRow({ item }: { item: Item }) {
  return (
    <TableRow>
      <TableCell>{new Date(item.createdAt).toLocaleString('pt-BR')}</TableCell>
      <TableCell>{item.author?.name ?? item.author?.email ?? '—'}</TableCell>
      <TableCell>{item.target.label}</TableCell>
      <TableCell>{item.channel?.name ?? 'canal removido'}</TableCell>
      <TableCell className="text-sm">{countsText(item.counts)}</TableCell>
    </TableRow>
  );
}

export function RecentDispatches({ items }: { items: Item[] }) {
  if (items.length === 0) {
    return <p className="text-sm text-muted-foreground">Nenhum envio ainda.</p>;
  }
  return (
    <div className="rounded-md border" style={{ borderColor: 'var(--border)' }}>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Data</TableHead><TableHead>Autor</TableHead><TableHead>Destino</TableHead>
            <TableHead>Canal</TableHead><TableHead>Situação</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>{items.map((i) => <DispatchRow key={i.id} item={i} />)}</TableBody>
      </Table>
    </div>
  );
}
