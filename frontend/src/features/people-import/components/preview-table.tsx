import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ROW_CLASS_LABEL } from '../labels';
import type { RowClass, RowView } from '../schemas';

/** Os dois marcadores gerais da prévia: Criar pessoas novas e Atualizar pessoas existentes. */
export type RowGeneral = { createNew: boolean; updateExisting: boolean };

const EMPTY = '—';

/** Só Criar e Atualizar têm caixa; cada uma responde ao seu marcador geral. */
const GENERAL_OF: Partial<Record<RowClass, keyof RowGeneral>> = {
  CREATE: 'createNew',
  UPDATE: 'updateExisting',
};

const CLASS_VARIANT: Record<RowClass, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  CREATE: 'default',
  UPDATE: 'secondary',
  UNCHANGED: 'outline',
  INVALID: 'destructive',
  DUPLICATE: 'destructive',
  CONFLICT: 'destructive',
  IGNORED: 'outline',
};

function Outcome({ row }: { row: RowView }) {
  const { diff, reasons, warnings } = row;
  if (diff.length + reasons.length + warnings.length === 0)
    return <span className="text-muted-foreground">{EMPTY}</span>;
  return (
    <ul className="space-y-0.5 text-sm">
      {diff.map(({ field, label, before, after }) => (
        <li key={field}>{`${label}: ${before ?? EMPTY} → ${after ?? EMPTY}`}</li>
      ))}
      {reasons.map((text, i) => (
        <li key={`${i}-${text}`} className="text-destructive">
          {text}
        </li>
      ))}
      {warnings.map((text, i) => (
        <li key={`${i}-${text}`} className="text-amber-700">
          {text}
        </li>
      ))}
    </ul>
  );
}

type Props = {
  rows: RowView[];
  general: RowGeneral;
  /** Números das linhas tiradas à mão. */
  excluded: ReadonlySet<number>;
  onToggle: (row: RowView) => void;
};

function SelectCell({ row, general, excluded, onToggle }: Omit<Props, 'rows'> & { row: RowView }) {
  const group = GENERAL_OF[row.classification];
  if (!row.selectable || !group) return <TableCell />;
  return (
    <TableCell>
      <Checkbox
        aria-label={`Incluir a linha ${row.rowNumber}`}
        checked={general[group] && !excluded.has(row.rowNumber)}
        disabled={!general[group]}
        onCheckedChange={() => onToggle(row)}
      />
    </TableCell>
  );
}

/** Linhas da prévia (E5): número no arquivo, classificação, nome, matrícula, setor e o que acontece. */
export function PreviewTable({ rows, ...selection }: Props) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-8">
            <span className="sr-only">Incluir</span>
          </TableHead>
          <TableHead>Linha</TableHead>
          <TableHead>Classificação</TableHead>
          <TableHead>Nome</TableHead>
          <TableHead>Matrícula</TableHead>
          <TableHead>Setor</TableHead>
          <TableHead>O que acontece</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.rowNumber}>
            <SelectCell row={row} {...selection} />
            <TableCell>{row.rowNumber}</TableCell>
            <TableCell>
              <Badge variant={CLASS_VARIANT[row.classification]}>{ROW_CLASS_LABEL[row.classification]}</Badge>
            </TableCell>
            <TableCell>{row.name ?? EMPTY}</TableCell>
            <TableCell>{row.registration ?? EMPTY}</TableCell>
            <TableCell>{row.sector ?? EMPTY}</TableCell>
            <TableCell>
              <Outcome row={row} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
