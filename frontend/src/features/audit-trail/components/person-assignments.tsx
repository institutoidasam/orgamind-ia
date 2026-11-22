import { AlertCircle } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { formatDatePtBr } from '@/lib/format-date-ptbr';
import { usePersonAssignments } from '../api';
import type { AuditRef, PersonAssignment } from '../schemas';

const LOADING_TEXT = 'Carregando vínculos…';
const ERROR_TEXT = 'Não foi possível carregar os vínculos.';
const EMPTY_TEXT = 'Nenhum vínculo registrado.';
const NO_START_TEXT = 'Anterior ao histórico';
const CURRENT_TEXT = 'Atual';

function RefCell({ value, blank }: { value: AuditRef | null; blank: string }) {
  if (!value) return <TableCell className="text-muted-foreground">{blank}</TableCell>;
  return <TableCell>{value.name}</TableCell>;
}

function AssignmentRow({ assignment }: { assignment: PersonAssignment }) {
  const { sector, shift, level, from, to } = assignment;
  return (
    <TableRow>
      <RefCell value={sector} blank="Sem setor" />
      <RefCell value={shift} blank="Sem turno" />
      <RefCell value={level} blank="Sem nível" />
      <TableCell className="whitespace-nowrap">{from ? formatDatePtBr(from) : NO_START_TEXT}</TableCell>
      <TableCell className="whitespace-nowrap">{to ? formatDatePtBr(to) : CURRENT_TEXT}</TableCell>
    </TableRow>
  );
}

function AssignmentsTable({ items }: { items: PersonAssignment[] }) {
  return (
    <div className="rounded-md border" style={{ borderColor: 'var(--border)' }}>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Setor</TableHead>
            <TableHead>Turno</TableHead>
            <TableHead>Nível</TableHead>
            <TableHead>De</TableHead>
            <TableHead>Até</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((assignment) => <AssignmentRow key={assignment.id} assignment={assignment} />)}
        </TableBody>
      </Table>
    </div>
  );
}

function AssignmentsContent({ userId }: { userId: string }) {
  const { data, isLoading, error } = usePersonAssignments(userId);
  if (isLoading) return <p role="status" className="text-sm text-muted-foreground">{LOADING_TEXT}</p>;
  if (error) {
    return (
      <Alert variant="destructive">
        <AlertCircle />
        <AlertDescription>{ERROR_TEXT}</AlertDescription>
      </Alert>
    );
  }
  if (!data) return null;
  if (data.items.length === 0) return <p className="text-sm text-muted-foreground">{EMPTY_TEXT}</p>;
  return <AssignmentsTable items={data.items} />;
}

/** Vínculos (setor, turno, nível, de e até) de uma pessoa, na ordem da API: o aberto primeiro (DV14). */
export function PersonAssignments({ userId }: { userId: string }) {
  return (
    <section className="space-y-2">
      <h3 className="text-base font-semibold">Vínculos</h3>
      <AssignmentsContent userId={userId} />
    </section>
  );
}
