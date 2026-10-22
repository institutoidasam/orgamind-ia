import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { OFF_REASON_LABEL, recipientStatusLabel } from '../error-messages';
import type { DispatchList } from '../schemas';

type Item = DispatchList['items'][number];

function countsText({ queued, sent, failed, skipped, scheduled, cancelled }: Item['counts']): string {
  const base = `Enfileirados ${queued} · Enviados ${sent} · Falhas ${failed} · Pulados ${skipped}`;
  return [base, scheduled > 0 && `Agendados ${scheduled}`, cancelled > 0 && `Cancelados ${cancelled}`]
    .filter(Boolean)
    .join(' · ');
}

const STATE_LABEL = { SCHEDULED: 'Agendado', CANCELLED: 'Cancelado' } as const;

function StateBadge({ state }: { state: Item['state'] }) {
  if (state === 'DISPATCHED') return null;
  return <p className="font-medium">{STATE_LABEL[state]}</p>;
}

const joinParts = (parts: (string | null)[]): string => parts.filter(Boolean).join(' · ');

/** Uma linha do grupo, sem telefone: nome · função · turno ou motivo da folga. */
function personText(p: Item['unselected'][number]): string {
  return joinParts([p.name, p.jobTitle, p.shiftName, p.reason && OFF_REASON_LABEL[p.reason]]);
}

function Group({ title, lines }: { title: string; lines: { key: string; text: string }[] }) {
  if (lines.length === 0) return null;
  return (
    <div className="mt-1">
      <p className="font-medium">{title}</p>
      <ul aria-label={title} className="list-disc pl-4">
        {lines.map((l) => <li key={l.key}>{l.text}</li>)}
      </ul>
    </div>
  );
}

const personLines = (people: Item['unselected']) =>
  people.map((p, index) => ({ key: `${index}:${p.userId ?? p.name}`, text: personText(p) }));

function recipientLines(recipients: Item['recipients']) {
  // userId nulo (usuário apagado) pode repetir o nome, então o índice entra na chave.
  return recipients.map((r, index) => ({
    key: `${index}:${r.userId ?? r.name}`,
    text: `${joinParts([r.name, r.shiftName])} — ${recipientStatusLabel(r)}`,
  }));
}

/** Três grupos da foto da escala: Destinatários (com resultado), Escalados não marcados, De folga. */
function RecipientsDetails({ item }: { item: Item }) {
  if (item.recipients.length + item.unselected.length + item.off.length === 0) return null;
  return (
    <details className="mt-1">
      <summary className="cursor-pointer">Ver destinatários</summary>
      <Group title="Destinatários" lines={recipientLines(item.recipients)} />
      <Group title="Escalados não marcados" lines={personLines(item.unselected)} />
      <Group title="De folga" lines={personLines(item.off)} />
    </details>
  );
}

function DispatchRow({ item }: { item: Item }) {
  return (
    <TableRow>
      <TableCell>{new Date(item.createdAt).toLocaleString('pt-BR')}</TableCell>
      <TableCell>{item.author?.name ?? item.author?.email ?? '—'}</TableCell>
      <TableCell>{item.target.label}</TableCell>
      <TableCell>{item.channel?.name ?? 'canal removido'}</TableCell>
      <TableCell className="text-sm">
        <StateBadge state={item.state} />
        {countsText(item.counts)}
        <RecipientsDetails item={item} />
      </TableCell>
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
