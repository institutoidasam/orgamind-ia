import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { describeUserError } from '@/features/users/error-messages';
import { readApiErrorBody } from '@/lib/api-error';
import { reasonSchema } from '../reason';
import { ReasonField } from './reason-field';

type Props = {
  person: { name: string; isActive: boolean };
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (reason: string) => Promise<void>;
};

const FALLBACK_ERROR = 'Não foi possível concluir agora. Tente de novo.';

/**
 * Texto do servidor (C9) quando houver; senão o do código conhecido (a reativação recusada, E10,
 * chega só com `code`, sem `detail`); senão a mensagem genérica.
 */
async function describeError(error: unknown): Promise<string> {
  return (await readApiErrorBody(error))?.detail ?? (await describeUserError(error)) ?? FALLBACK_ERROR;
}

type FormProps = Omit<Props, 'open'>;

function PersonStatusForm({ person, onOpenChange, onConfirm }: FormProps) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const verb = person.isActive ? 'Inativar' : 'Reativar';
  const submit = async () => {
    const parsed = reasonSchema.safeParse(reason);
    if (!parsed.success) return setError(parsed.error.issues[0].message);
    setError(undefined);
    setPending(true);
    try {
      await onConfirm(parsed.data);
      onOpenChange(false);
    } catch (failure) {
      setError(await describeError(failure));
    } finally {
      setPending(false);
    }
  };
  return (
    <div className="space-y-4 py-2">
      <DialogHeader>
        <DialogTitle>{verb} {person.name}?</DialogTitle>
        <DialogDescription>
          {person.isActive
            ? 'A pessoa deixa de receber mensagens e de entrar no sistema. O histórico continua guardado.'
            : 'A pessoa volta a poder receber mensagens e, se tiver acesso, a entrar no sistema.'}
        </DialogDescription>
      </DialogHeader>
      <ReasonField value={reason} onChange={setReason} error={error} />
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>Cancelar</Button>
        <Button type="button" onClick={submit} disabled={pending}>{verb}</Button>
      </DialogFooter>
    </div>
  );
}

/** Confirmação de inativar ou reativar, com motivo obrigatório (spec A3 e A4). */
export function PersonStatusDialog({ open, ...form }: Props) {
  return (
    <Dialog open={open} onOpenChange={form.onOpenChange}>
      <DialogContent>
        <PersonStatusForm {...form} />
      </DialogContent>
    </Dialog>
  );
}
