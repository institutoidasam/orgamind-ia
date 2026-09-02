import { HTTPError } from 'ky';
import { toast } from 'sonner';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { extractApiError, type ApiError } from '@/lib/api-error';
import { useDeleteTemplate } from '../api';
import type { Template } from '../schemas';

const ERROR_MESSAGES = {
  // Keyed by backend ProblemDetails `code` (preferred), then HTTP status, then
  // the generic / non-HTTP fallbacks. The in_use message is the fallback used
  // when the backend gives a code but no human-readable `detail`.
  'template.in_use':
    'Template em uso por uma ou mais campanhas — não pode ser excluído.',
  403: 'Apenas administradores podem excluir templates',
  http: 'Falha ao excluir template',
  network: 'Erro de rede',
} as const;

/**
 * Map an extracted ApiError to the toast string, mirroring the prior branching.
 * For `template.in_use` we prefer the backend `detail` (carried in api.message
 * only when the body actually supplied one) and otherwise show the fallback.
 * `extractApiError` substitutes the ky message when no `detail`/`errors` exist,
 * so compare against it to know whether a real detail was returned.
 */
function deleteErrorMessage(err: unknown, api: ApiError): string {
  if (!(err instanceof HTTPError)) return ERROR_MESSAGES.network;
  if (api.code === 'template.in_use') {
    const hasDetail = api.message !== err.message;
    return hasDetail ? api.message : ERROR_MESSAGES['template.in_use'];
  }
  if (api.status === 403) return ERROR_MESSAGES[403];
  return ERROR_MESSAGES.http;
}

type DeleteTemplateDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  template: Template | null;
};

export function DeleteTemplateDialog({
  open,
  onOpenChange,
  template,
}: DeleteTemplateDialogProps) {
  const del = useDeleteTemplate();

  const onConfirm = async (e: React.MouseEvent<HTMLButtonElement>) => {
    if (!template) return;
    e.preventDefault();
    try {
      await del.mutateAsync(template.id);
      toast.success('Template excluído');
      onOpenChange(false);
    } catch (err) {
      const api = await extractApiError(err);
      toast.error(deleteErrorMessage(err, api));
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Excluir template?</AlertDialogTitle>
          <AlertDialogDescription>
            Esta ação não pode ser desfeita. O template{' '}
            <span className="font-medium">{template?.metaName}</span> será
            removido permanentemente.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={del.isPending}>Cancelar</AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            disabled={del.isPending}
            className="bg-destructive/10 text-destructive hover:bg-destructive/20"
          >
            {del.isPending ? 'Excluindo...' : 'Excluir'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
