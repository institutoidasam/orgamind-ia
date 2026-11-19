import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ROLE_LABEL } from '@/features/users/role';
import { PERMISSION_LABELS } from '../keys';
import type { MatrixChange } from '../matrix-diff';

type Props = {
  open: boolean;
  changes: MatrixChange[];
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

/** "<Papel>: passa a poder <nome>" ou "<Papel>: deixa de poder <nome>"; nunca a chave nem o papel cru. */
function changeText({ role, key, granted }: MatrixChange): string {
  return `${ROLE_LABEL[role]}: ${granted ? 'passa a poder' : 'deixa de poder'} ${PERMISSION_LABELS[key].name}`;
}

/** Confirmação de salvar ou restaurar a matriz, com uma linha por mudança (spec B5). */
export function PermissionsConfirmDialog({ open, changes, busy, onConfirm, onCancel }: Props) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && !busy && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Confirmar alterações de permissões</DialogTitle>
          <DialogDescription>
            A mudança vale na próxima ação de cada usuário desses papéis, sem precisar entrar de novo.
          </DialogDescription>
        </DialogHeader>
        <ul className="list-disc space-y-1 pl-5 text-sm">
          {changes.map((change) => (
            <li key={`${change.role}:${change.key}`}>{changeText(change)}</li>
          ))}
        </ul>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
            Cancelar
          </Button>
          <Button type="button" onClick={onConfirm} disabled={busy}>
            {busy ? 'Salvando…' : 'Salvar'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
