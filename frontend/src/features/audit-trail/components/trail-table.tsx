import { Badge } from '@/components/ui/badge';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { actionLabel, categoryLabel, fieldLabel, formatAuditDateTime, formatAuditValue } from '../labels';
import type { AuditTrailEntry, FieldChange } from '../schemas';

const NO_DETAIL_TEXT = 'Sem detalhe das alterações';
const EMPTY_TEXT = '—';

function ChangesCell({ changes }: { changes: FieldChange[] | null }) {
  if (changes === null) return <span className="text-sm italic text-muted-foreground">{NO_DETAIL_TEXT}</span>;
  if (changes.length === 0) return <span className="text-muted-foreground">{EMPTY_TEXT}</span>;
  return (
    <ul className="space-y-0.5 text-sm">
      {changes.map(({ field, before, after }) => (
        <li key={field}>{`${fieldLabel(field)}: ${formatAuditValue(field, before)} → ${formatAuditValue(field, after)}`}</li>
      ))}
    </ul>
  );
}

function SubjectCell({ subject }: { subject: AuditTrailEntry['subject'] }) {
  if (!subject) return <span className="text-muted-foreground">{EMPTY_TEXT}</span>;
  return (
    <div>
      <div>{subject.name ?? EMPTY_TEXT}</div>
      {subject.registration && <div className="text-xs text-muted-foreground">{`Matrícula ${subject.registration}`}</div>}
    </div>
  );
}

function TrailRow({ entry, showSubject }: { entry: AuditTrailEntry; showSubject: boolean }) {
  return (
    <TableRow>
      <TableCell className="whitespace-nowrap align-top">
        <time dateTime={entry.createdAt}>{formatAuditDateTime(entry.createdAt)}</time>
      </TableCell>
      <TableCell className="align-top">{entry.actor?.name ?? EMPTY_TEXT}</TableCell>
      <TableCell className="align-top">
        <Badge variant="outline">{categoryLabel(entry.category)}</Badge>
        <div className="mt-1 text-sm">{actionLabel(entry.action)}</div>
      </TableCell>
      {showSubject && <TableCell className="align-top"><SubjectCell subject={entry.subject} /></TableCell>}
      <TableCell className="align-top">{entry.reason ?? EMPTY_TEXT}</TableCell>
      <TableCell className="align-top"><ChangesCell changes={entry.changes} /></TableCell>
    </TableRow>
  );
}

type Props = {
  entries: AuditTrailEntry[];
  /** `false` no histórico de uma pessoa: a coluna Pessoa seria sempre a mesma. */
  showSubject: boolean;
};

/** Registros da trilha, na ordem recebida; compartilhada pela tela Trilha e pelo Histórico da pessoa. */
export function TrailTable({ entries, showSubject }: Props) {
  return (
    <div className="rounded-md border" style={{ borderColor: 'var(--border)' }}>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Data e hora</TableHead>
            <TableHead>Autor</TableHead>
            <TableHead>Tipo</TableHead>
            {showSubject && <TableHead>Pessoa</TableHead>}
            <TableHead>Motivo</TableHead>
            <TableHead>Alterações</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {entries.length === 0 && (
            <TableRow>
              <TableCell colSpan={showSubject ? 6 : 5} className="text-center text-muted-foreground">
                Nenhum registro encontrado.
              </TableCell>
            </TableRow>
          )}
          {entries.map((entry) => <TrailRow key={entry.id} entry={entry} showSubject={showSubject} />)}
        </TableBody>
      </Table>
    </div>
  );
}
