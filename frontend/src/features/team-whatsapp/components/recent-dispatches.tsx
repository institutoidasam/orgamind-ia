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

type Line = { key: string; text: string; sector: string | null };

/** Uma linha do grupo, sem telefone: nome · nível · função · turno ou motivo da folga. */
function personText(p: Item['unselected'][number]): string {
  return joinParts([p.name, p.levelName, p.jobTitle, p.shiftName, p.reason && OFF_REASON_LABEL[p.reason]]);
}

const personLines = (people: Item['unselected']): Line[] =>
  people.map((p, index) => ({ key: `${index}:${p.userId ?? p.name}`, text: personText(p), sector: p.sectorName }));

function recipientLines(recipients: Item['recipients']): Line[] {
  // userId nulo (usuário apagado) pode repetir o nome, então o índice entra na chave.
  return recipients.map((r, index) => ({
    key: `${index}:${r.userId ?? r.name}`,
    text: `${joinParts([r.name, r.levelName, r.shiftName])} — ${recipientStatusLabel(r)}`,
    sector: r.sectorName,
  }));
}

const NO_SECTOR = 'Sem setor';

/** Subgrupos na ordem dos setores do envio; quem não bate com nenhum (ou sem setor) vai depois. */
function bySector(lines: Line[], order: string[]): [string, Line[]][] {
  const buckets = new Map<string, Line[]>(order.map((name) => [name, []]));
  for (const line of lines) {
    const name = line.sector ?? NO_SECTOR;
    buckets.set(name, [...(buckets.get(name) ?? []), line]);
  }
  return [...buckets].filter(([, bucket]) => bucket.length > 0);
}

function LineList({ label, lines }: { label: string; lines: Line[] }) {
  return (
    <ul aria-label={label} className="list-disc pl-4">
      {lines.map((l) => <li key={l.key}>{l.text}</li>)}
    </ul>
  );
}

/** `sectorOrder` só vem com mais de um setor no envio: aí cada grupo se divide por setor. */
function Group({ title, lines, sectorOrder }: { title: string; lines: Line[]; sectorOrder: string[] | null }) {
  if (lines.length === 0) return null;
  return (
    <div className="mt-1">
      <p className="font-medium">{title}</p>
      {sectorOrder ? bySector(lines, sectorOrder).map(([sector, bucket]) => (
        <div key={sector} className="ml-2">
          <p className="text-muted-foreground">{sector}</p>
          <LineList label={`${title} · ${sector}`} lines={bucket} />
        </div>
      )) : <LineList label={title} lines={lines} />}
    </div>
  );
}

/** Três grupos da foto da escala: Destinatários (com resultado), Escalados não marcados, De folga. */
function RecipientsDetails({ item }: { item: Item }) {
  if (item.recipients.length + item.unselected.length + item.off.length === 0) return null;
  const sectorOrder = item.sectors.length > 1 ? item.sectors.map((s) => s.name) : null;
  return (
    <details className="mt-1">
      <summary className="cursor-pointer">Ver destinatários</summary>
      <Group title="Destinatários" lines={recipientLines(item.recipients)} sectorOrder={sectorOrder} />
      <Group title="Escalados não marcados" lines={personLines(item.unselected)} sectorOrder={sectorOrder} />
      <Group title="De folga" lines={personLines(item.off)} sectorOrder={sectorOrder} />
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
