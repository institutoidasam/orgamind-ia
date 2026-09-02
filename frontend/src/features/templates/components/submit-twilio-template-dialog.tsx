// twilio-platform T5 — confirmação de "Submeter à aprovação" (Content API).
//
// Submeter é irreversível: depois disso o rascunho não pode mais ser editado
// na Twilio (correção = clonar). O DomainError PT-BR do backend aparece
// INLINE aqui — o dialog fica aberto para o operador ler e decidir.
import { useState } from 'react';
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
import { extractApiError } from '@/lib/api-error';
import { useSubmitTwilioTemplate } from '../api';
import type { Template } from '../schemas';

type SubmitTwilioTemplateDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  template: Template | null;
};

export function SubmitTwilioTemplateDialog({
  open,
  onOpenChange,
  template,
}: SubmitTwilioTemplateDialogProps) {
  const submit = useSubmitTwilioTemplate();
  const [serverError, setServerError] = useState<string | null>(null);

  // Um erro de uma tentativa anterior não deve reaparecer ao reabrir o
  // dialog para outro template — limpa no fechamento (sem effect).
  const handleOpenChange = (next: boolean) => {
    if (!next) setServerError(null);
    onOpenChange(next);
  };

  const onConfirm = async (e: React.MouseEvent<HTMLButtonElement>) => {
    if (!template) return;
    e.preventDefault();
    setServerError(null);
    try {
      await submit.mutateAsync(template.id);
      toast.success('Template submetido à aprovação da Meta');
      onOpenChange(false);
    } catch (err) {
      const api = await extractApiError(err);
      setServerError(api.message);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Submeter à aprovação?</AlertDialogTitle>
          <AlertDialogDescription>
            Após submeter, o template não pode mais ser editado — a Meta pode
            levar horas para aprovar. O template{' '}
            <span className="font-medium">{template?.metaName}</span> será
            enviado na categoria{' '}
            <span className="font-medium">{template?.category}</span>.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {serverError && (
          <div
            role="alert"
            className="whitespace-pre-wrap rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive"
          >
            {serverError}
          </div>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={submit.isPending}>
            Cancelar
          </AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm} disabled={submit.isPending}>
            {submit.isPending ? 'Submetendo...' : 'Submeter'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
