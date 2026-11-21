import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { deactivateLevelText } from '../in-use';

type Props = {
  open: boolean;
  name: string;
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

/** Confirma a desativação do nível sem uso (E6); o servidor ainda recusa se o uso surgir depois. */
export function LevelDeactivateDialog({ open, name, pending, onConfirm, onCancel }: Props) {
  return (
    <AlertDialog open={open} onOpenChange={(next) => !next && !pending && onCancel()}>
      {/* Sem descrição: `aria-describedby` undefined cala o aviso do Radix. */}
      <AlertDialogContent aria-describedby={undefined}>
        <AlertDialogHeader>
          <AlertDialogTitle className="leading-snug">{deactivateLevelText(name)}</AlertDialogTitle>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancelar</AlertDialogCancel>
          <Button onClick={onConfirm} disabled={pending}>
            Desativar
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
