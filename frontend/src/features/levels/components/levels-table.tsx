import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Pencil, type LucideIcon } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useReorderLevels, useUpdateLevel } from '../api';
import { describeLevelError } from '../error-messages';
import { LEVELS_QUERY_KEY, LEVEL_IN_USE_CODE, levelInUse } from '../in-use';
import type { LevelAdmin } from '../schemas';
import { LevelDeactivateDialog } from './level-deactivate-dialog';
import { LevelInUse } from './level-in-use';

type Props = {
  loading: boolean;
  items: LevelAdmin[];
  onEdit: (level: LevelAdmin) => void;
};

/** Nova ordem dos ids com o item de `index` trocado com o vizinho (`offset` -1 ou 1). */
function swapIds(items: LevelAdmin[], index: number, offset: -1 | 1): string[] {
  const ids = items.map((item) => item.id);
  [ids[index], ids[index + offset]] = [ids[index + offset], ids[index]];
  return ids;
}

export function LevelsTable({ loading, items, onEdit }: Props) {
  const { busy, change, reorder, deactivation } = useLevelActions();
  if (loading) return <Skeleton className="h-40 w-full" />;
  if (items.length === 0) {
    return <p className="rounded-lg border p-6 text-sm text-muted-foreground">Nenhum nível cadastrado.</p>;
  }
  return (
    <div className="rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Nível</TableHead>
            <TableHead>Pessoas</TableHead>
            <TableHead className="text-right">Ações</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((level, index) => (
            <TableRow key={level.id}>
              <LevelNameCell level={level} />
              <TableCell>{level.userCount} pessoa(s)</TableCell>
              <TableCell>
                <div className="flex flex-wrap justify-end gap-1">
                  {rowActions({
                    level,
                    busy,
                    first: index === 0,
                    last: index === items.length - 1,
                    run: {
                      edit: () => onEdit(level),
                      toggle: () => (level.isActive ? deactivation.ask(level) : change({ id: level.id, isActive: true })),
                      move: (offset) => reorder(swapIds(items, index, offset)),
                    },
                  }).map((action) => (
                    <RowButton key={action.label} {...action} />
                  ))}
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <DeactivateDialog deactivation={deactivation} pending={busy} />
    </div>
  );
}

type Deactivation = ReturnType<typeof useLevelActions>['deactivation'];

function DeactivateDialog({ deactivation, pending }: { deactivation: Deactivation; pending: boolean }) {
  return (
    <LevelDeactivateDialog
      open={deactivation.level !== null}
      name={deactivation.level?.name ?? ''}
      pending={pending}
      onConfirm={deactivation.confirm}
      onCancel={deactivation.cancel}
    />
  );
}

function LevelNameCell({ level }: { level: LevelAdmin }) {
  return (
    <TableCell>
      <span className="font-medium">{level.name}</span>
      {!level.isActive && <Badge variant="secondary" className="ml-2">Inativo</Badge>}
      <LevelInUse level={level} />
    </TableCell>
  );
}

function useLevelActions() {
  const client = useQueryClient();
  const update = useUpdateLevel();
  const reorderMutation = useReorderLevels();
  const [deactivating, setDeactivating] = useState<LevelAdmin | null>(null);
  const guard = async (request: Promise<unknown>) => {
    try {
      await request;
    } catch (error) {
      const { code, message } = await describeLevelError(error);
      toast.error(message);
      // O uso surgiu depois de a tela abrir (E5): recarrega a lista com as contagens novas.
      if (code === LEVEL_IN_USE_CODE) await client.invalidateQueries({ queryKey: LEVELS_QUERY_KEY });
    }
  };
  const change = (input: Parameters<typeof update.mutateAsync>[0]) => guard(update.mutateAsync(input));
  const confirm = async () => {
    if (!deactivating) return;
    await change({ id: deactivating.id, isActive: false });
    setDeactivating(null);
  };
  return {
    busy: update.isPending || reorderMutation.isPending,
    change,
    reorder: (ids: string[]) => guard(reorderMutation.mutateAsync(ids)),
    deactivation: { level: deactivating, ask: setDeactivating, confirm, cancel: () => setDeactivating(null) },
  };
}

type ActionSpec = { label: string; icon?: LucideIcon; disabled: boolean; ghost?: boolean; onClick: () => unknown };

type RowActionsInput = {
  level: LevelAdmin;
  busy: boolean;
  first: boolean;
  last: boolean;
  run: { edit: () => void; toggle: () => unknown; move: (offset: -1 | 1) => unknown };
};

function rowActions({ level, busy, first, last, run }: RowActionsInput): ActionSpec[] {
  return [
    { label: 'Subir', icon: ArrowUp, ghost: true, disabled: busy || first, onClick: () => run.move(-1) },
    { label: 'Descer', icon: ArrowDown, ghost: true, disabled: busy || last, onClick: () => run.move(1) },
    { label: 'Editar', icon: Pencil, disabled: false, onClick: run.edit },
    { label: level.isActive ? 'Desativar' : 'Reativar', disabled: busy || levelInUse(level), onClick: run.toggle },
  ];
}

function RowButton({ label, icon: Icon, disabled, ghost, onClick }: ActionSpec) {
  return (
    <Button size="sm" variant={ghost ? 'ghost' : 'outline'} disabled={disabled} onClick={onClick}>
      {Icon && <Icon className="mr-1 size-3.5" aria-hidden />}
      {label}
    </Button>
  );
}
