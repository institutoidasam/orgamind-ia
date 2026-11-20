import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { extractApiError, readApiErrorBody } from '@/lib/api-error';
import { invalidateBatchPreview, useConfirmImport, useImportBatch, type ConfirmSelection } from '../api';
import { confirmText } from '../labels';
import type { BatchSummary } from '../schemas';

const ALREADY_CONFIRMED = 'people_import.already_confirmed';
const PREVIEW_CHANGED = 'people_import.preview_changed';
const PREVIEW_CHANGED_TITLE = 'A prévia mudou';
const PREVIEW_CHANGED_DETAIL = 'A prévia mudou depois que você a abriu. Confira de novo antes de confirmar.';

type Props = {
  batchId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  toCreate: number;
  toUpdate: number;
  selection: ConfirmSelection;
  onConfirmed: (summary: BatchSummary) => void;
  /** A prévia que a tela mostrava não vale mais (409 `preview_changed`): a escolha volta ao padrão. */
  onPreviewChanged: () => void;
};

type ConfirmProps = Pick<Props, 'batchId' | 'selection' | 'onConfirmed' | 'onOpenChange' | 'onPreviewChanged'>;

/**
 * Confirma o lote com a seleção da tela. 409 `already_confirmed` (a outra aba confirmou
 * antes) não é erro: relê o resumo e entrega ao andamento. O servidor confirma uma vez só.
 * 409 `preview_changed` (a prévia mudou depois de aberta, ex.: outra aba remapeou): fecha o
 * diálogo, zera a escolha, avisa e relê resumo e linhas; a contagem mostrada era de outra prévia.
 */
function useConfirm({ batchId, selection, onConfirmed, onOpenChange, onPreviewChanged }: ConfirmProps) {
  const confirmImport = useConfirmImport(batchId);
  const summary = useImportBatch(batchId);
  const client = useQueryClient();
  const confirm = async () => {
    try {
      onConfirmed(await confirmImport.mutateAsync(selection));
    } catch (error) {
      const code = (await readApiErrorBody(error))?.code;
      if (code === PREVIEW_CHANGED) {
        onOpenChange(false);
        onPreviewChanged();
        invalidateBatchPreview(client, batchId);
        toast.error(PREVIEW_CHANGED_TITLE, { description: PREVIEW_CHANGED_DETAIL });
        return;
      }
      if (code === ALREADY_CONFIRMED) {
        // Releitura que falha devolve em `data` o resumo antigo (ainda em prévia): só segue com resumo novo.
        const { data, isError } = await summary.refetch();
        if (data && !isError && data.situation !== 'PREVIEW') return onConfirmed(data);
      }
      const { title, message } = await extractApiError(error);
      toast.error(title, { description: message });
    }
  };
  return { confirm, pending: confirmImport.isPending };
}

/** Pede a confirmação final (E5): a contagem por extenso e o aviso de que não dá para desfazer pela planilha. */
export function ConfirmDialog({ open, onOpenChange, toCreate, toUpdate, ...rest }: Props) {
  const { confirm, pending } = useConfirm({ ...rest, onOpenChange });
  return (
    <AlertDialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Confirmar importação</AlertDialogTitle>
          <AlertDialogDescription>
            <span className="block font-medium text-foreground">{confirmText(toCreate, toUpdate)}</span>
            <span className="block">Depois de confirmar, a gravação começa e não dá para desfazer pela planilha.</span>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancelar</AlertDialogCancel>
          <Button onClick={() => void confirm()} disabled={pending}>
            Confirmar
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
