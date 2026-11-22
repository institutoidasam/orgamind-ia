import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { QueryErrorFallback } from '@/components/query-error-fallback';
import { extractApiError } from '@/lib/api-error';
import { ROLE_LABEL, type UserRole } from '@/features/users/role';
import { useRestorePermissionDefaults, usePermissionMatrix, useSavePermissionMatrix } from '../api';
import { PERMISSION_LABELS, type PermissionKey } from '../keys';
import { matrixChanges, setGranted, toDraft, type EditableRole, type MatrixChange, type MatrixDraft } from '../matrix-diff';
import type { PermissionMatrix } from '../schemas';
import { PermissionsConfirmDialog } from './permissions-confirm-dialog';

const COLUMNS: readonly UserRole[] = ['ADMIN', 'SUPERVISOR', 'OPERATOR', 'VIEWER'];

type Pending = { kind: 'save' | 'restore'; changes: MatrixChange[] };

type TableProps = {
  matrix: PermissionMatrix;
  draft: MatrixDraft;
  onToggle: (role: EditableRole, key: PermissionKey, granted: boolean) => void;
};

/** Só SUPERVISOR e OPERATOR têm rascunho; os outros papéis mostram o que a API devolveu. */
function draftList(draft: MatrixDraft, role: UserRole): PermissionKey[] | undefined {
  return role === 'SUPERVISOR' || role === 'OPERATOR' ? draft[role] : undefined;
}

function MatrixRow({ permission, matrix, draft, onToggle }: TableProps & { permission: PermissionKey }) {
  const { name, description } = PERMISSION_LABELS[permission];
  return (
    <TableRow>
      <TableCell className="whitespace-normal">
        <p className="font-medium">{name}</p>
        <p className="text-xs" style={{ color: 'var(--foreground-muted)' }}>{description}</p>
      </TableCell>
      {COLUMNS.map((role) => {
        const edited = draftList(draft, role);
        const editable = edited !== undefined && matrix.editableRoles.some((item) => item === role);
        return (
          <TableCell key={role} className="text-center">
            <Checkbox
              aria-label={`${ROLE_LABEL[role]}: ${name}`}
              checked={(edited ?? matrix.roles[role]).includes(permission)}
              disabled={!editable}
              onCheckedChange={(checked) => editable && onToggle(role as EditableRole, permission, checked === true)}
            />
          </TableCell>
        );
      })}
    </TableRow>
  );
}

function MatrixTable(props: TableProps) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Permissão</TableHead>
          {COLUMNS.map((role) => (
            <TableHead key={role} className="text-center">{ROLE_LABEL[role]}</TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {props.matrix.keys.map((permission) => (
          <MatrixRow key={permission} permission={permission} {...props} />
        ))}
      </TableBody>
    </Table>
  );
}

type ActionsProps = { canRestore: boolean; canSave: boolean; onRestore: () => void; onSave: () => void };

function MatrixActions({ canRestore, canSave, onRestore, onSave }: ActionsProps) {
  return (
    <div className="flex justify-end gap-2">
      <Button type="button" variant="outline" disabled={!canRestore} onClick={onRestore}>
        Restaurar padrão
      </Button>
      <Button type="button" disabled={!canSave} onClick={onSave}>
        Salvar
      </Button>
    </div>
  );
}

function MatrixEditor({ matrix }: { matrix: PermissionMatrix }) {
  const [draft, setDraft] = useState<MatrixDraft>(() => toDraft(matrix.roles));
  const [pending, setPending] = useState<Pending | null>(null);
  const save = useSavePermissionMatrix();
  const restore = useRestorePermissionDefaults();
  const saveChanges = matrixChanges(matrix.roles, draft);
  const restoreChanges = matrixChanges(matrix.roles, matrix.defaults);

  async function confirm() {
    if (!pending) return;
    try {
      const saved = pending.kind === 'save' ? await save.mutateAsync(draft) : await restore.mutateAsync();
      setDraft(toDraft(saved.roles));
      setPending(null);
      toast.success(pending.kind === 'save' ? 'Permissões salvas' : 'Permissões restauradas ao padrão');
    } catch (error) {
      const { message } = await extractApiError(error);
      toast.error('Não foi possível salvar as permissões', { description: message });
    }
  }

  return (
    <div className="space-y-4">
      <MatrixTable
        matrix={matrix}
        draft={draft}
        onToggle={(role, key, granted) => setDraft((current) => setGranted(current, role, key, granted))}
      />
      <MatrixActions
        canRestore={restoreChanges.length > 0}
        canSave={saveChanges.length > 0}
        onRestore={() => setPending({ kind: 'restore', changes: restoreChanges })}
        onSave={() => setPending({ kind: 'save', changes: saveChanges })}
      />
      <PermissionsConfirmDialog
        open={pending !== null}
        changes={pending?.changes ?? []}
        busy={save.isPending || restore.isPending}
        onConfirm={() => void confirm()}
        onCancel={() => setPending(null)}
      />
    </div>
  );
}

/** Tela Permissões (spec B5): uma linha por permissão, uma coluna por papel; ADMIN e VIEWER travados. */
export function PermissionsMatrix() {
  const query = usePermissionMatrix();
  if (query.isError) return <QueryErrorFallback error={query.error} onRetry={() => void query.refetch()} />;
  if (!query.data) return <Skeleton className="h-64 w-full" />;
  return <MatrixEditor matrix={query.data} />;
}
