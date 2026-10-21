import { useState } from 'react';
import { createFileRoute, redirect } from '@tanstack/react-router';
import { ArrowDown, ArrowUp, Pencil, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { QueryErrorFallback } from '@/components/query-error-fallback';
import { useAuthStore } from '@/stores/auth.store';
import { useReorderShifts, useShifts, useUpdateShift } from '@/features/shifts/api';
import { ShiftFormDialog } from '@/features/shifts/components/shift-form-dialog';
import { describeShiftError } from '@/features/shifts/error-messages';
import { inUseText } from '@/features/shifts/in-use';
import { CROSSES_MIDNIGHT_LABEL, shiftRangeLabel } from '@/features/shifts/labels';
import type { ShiftAdmin } from '@/features/shifts/schemas';

const route = createFileRoute('/_authenticated/turnos/')({
  beforeLoad: () => {
    const { user } = useAuthStore.getState();
    if (user?.role !== 'ADMIN') {
      throw redirect({ to: '/dashboard' });
    }
  },
  component: ShiftsPage,
});
export { route as Route };

/** `null` = fechado; `{}` = turno novo; `{ shift }` = edição. */
type Editor = { shift?: ShiftAdmin } | null;

function ShiftsPage() {
  const shifts = useShifts();
  const [editor, setEditor] = useState<Editor>(null);
  if (shifts.isError) return <QueryErrorFallback error={shifts.error} onRetry={shifts.refetch} />;
  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Turnos</h1>
          <p className="text-sm text-muted-foreground">
            Horários usados no cadastro de pessoas, na escala e no WhatsApp da equipe.
          </p>
        </div>
        <Button onClick={() => setEditor({})}>
          <Plus className="mr-2 size-4" />
          Novo turno
        </Button>
      </header>
      <ShiftList loading={shifts.isLoading} items={shifts.data ?? []} onEdit={(shift) => setEditor({ shift })} />
      <ShiftFormDialog open={editor !== null} shift={editor?.shift} onOpenChange={(open) => !open && setEditor(null)} />
    </div>
  );
}

function ShiftList({ loading, items, onEdit }: { loading: boolean; items: ShiftAdmin[]; onEdit: (shift: ShiftAdmin) => void }) {
  const actions = useShiftActions(items);
  if (loading) {
    return (
      <div className="space-y-2">
        {[1, 2, 3].map((n) => (
          <Skeleton key={n} className="h-12 w-full" />
        ))}
      </div>
    );
  }
  if (!items.length) {
    return <p className="rounded-lg border p-6 text-sm text-muted-foreground">Nenhum turno cadastrado.</p>;
  }
  return (
    <div className="rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Turno</TableHead>
            <TableHead>Horário</TableHead>
            <TableHead className="text-right">Ações</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((shift, index) => (
            <ShiftRow key={shift.id} shift={shift} position={{ index, last: items.length - 1 }} actions={actions} onEdit={onEdit} />
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function useShiftActions(items: ShiftAdmin[]) {
  const update = useUpdateShift();
  const reorder = useReorderShifts();
  const run = async (request: () => Promise<unknown>) => {
    try {
      await request();
    } catch (error) {
      toast.error((await describeShiftError(error)).message);
    }
  };
  return {
    busy: update.isPending || reorder.isPending,
    setActive: (shift: ShiftAdmin, isActive: boolean) => run(() => update.mutateAsync({ id: shift.id, isActive })),
    move: (index: number, offset: -1 | 1) => {
      const ids = items.map((item) => item.id);
      [ids[index], ids[index + offset]] = [ids[index + offset], ids[index]];
      return run(() => reorder.mutateAsync(ids));
    },
  };
}

type Actions = ReturnType<typeof useShiftActions>;
type RowProps = {
  shift: ShiftAdmin;
  position: { index: number; last: number };
  actions: Actions;
  onEdit: (shift: ShiftAdmin) => void;
};

function ShiftRow({ shift, position, actions, onEdit }: RowProps) {
  const usage = inUseText(shift.inUse);
  return (
    <TableRow>
      <TableCell>
        <span className="font-medium">{shift.name}</span>
        {!shift.isActive && <Badge variant="secondary" className="ml-2">Inativo</Badge>}
        {usage && <p className="text-xs text-muted-foreground">{usage}</p>}
      </TableCell>
      <TableCell>
        <span>{shiftRangeLabel(shift)}</span>
        {shift.crossesMidnight && <Badge variant="outline" className="ml-2">{CROSSES_MIDNIGHT_LABEL}</Badge>}
      </TableCell>
      <TableCell>
        <div className="flex flex-wrap justify-end gap-1">
          <Button size="sm" variant="ghost" disabled={actions.busy || position.index === 0} onClick={() => actions.move(position.index, -1)}>
            <ArrowUp className="mr-1 size-3.5" aria-hidden />
            Subir
          </Button>
          <Button size="sm" variant="ghost" disabled={actions.busy || position.index === position.last} onClick={() => actions.move(position.index, 1)}>
            <ArrowDown className="mr-1 size-3.5" aria-hidden />
            Descer
          </Button>
          <Button size="sm" variant="outline" onClick={() => onEdit(shift)}>
            <Pencil className="mr-1 size-3.5" aria-hidden />
            Editar
          </Button>
          <ToggleActiveButton shift={shift} actions={actions} />
        </div>
      </TableCell>
    </TableRow>
  );
}

function ToggleActiveButton({ shift, actions }: { shift: ShiftAdmin; actions: Actions }) {
  if (!shift.isActive) {
    return (
      <Button size="sm" variant="outline" disabled={actions.busy} onClick={() => actions.setActive(shift, true)}>
        Reativar
      </Button>
    );
  }
  return (
    <Button size="sm" variant="outline" disabled={actions.busy || shift.inUse.length > 0} onClick={() => actions.setActive(shift, false)}>
      Desativar
    </Button>
  );
}
