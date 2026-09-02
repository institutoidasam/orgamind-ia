import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useCreateInstance, useInstanceQr } from '../api';
import { createInstanceInputSchema, type CreateInstanceInput, type Instance, type InstanceQr } from '../schemas';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (i: Instance) => void;
};

export function CreateInstanceDialog({ open, onOpenChange, onCreated }: Props) {
  const [created, setCreated] = useState<Instance | null>(null);
  const form = useForm<CreateInstanceInput>({
    resolver: zodResolver(createInstanceInputSchema),
    defaultValues: { name: '', isDefault: false },
  });
  const create = useCreateInstance();
  // Only poll the QR endpoint while the dialog is actually open; otherwise a
  // dialog closed on the QR step keeps churning a request every few seconds.
  const qr = useInstanceQr(open ? created?.id : undefined);

  // Closing the dialog must clear the created-instance state so a re-open starts
  // fresh on the form step (and the QR poll above stays disabled).
  const handleOpenChange = (next: boolean) => {
    if (!next) setCreated(null);
    onOpenChange(next);
  };

  useEffect(() => {
    if (qr.data?.state === 'open' && created) {
      const t = setTimeout(() => {
        onCreated(created); // pass the originally-created instance
        onOpenChange(false);
        setCreated(null);
      }, 800);
      return () => clearTimeout(t);
    }
  }, [qr.data?.state, created, onCreated, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{created ? 'Escaneie o QR' : 'Nova conexão'}</DialogTitle>
        </DialogHeader>

        {!created ? (
          <form
            onSubmit={form.handleSubmit(async (input) => {
              const inst = await create.mutateAsync(input);
              setCreated(inst);
            })}
            className="space-y-3"
          >
            <div className="space-y-1">
              <Label htmlFor="name">Nome de exibição</Label>
              <Input id="name" {...form.register('name')} />
              {form.formState.errors.name && (
                <p className="text-xs text-destructive">{form.formState.errors.name.message}</p>
              )}
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" {...form.register('isDefault')} />
              Marcar como conexão padrão
            </label>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => handleOpenChange(false)}>Cancelar</Button>
              <Button type="submit" disabled={create.isPending}>
                {create.isPending ? 'Criando…' : 'Criar e gerar QR'}
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <QrPane
            qr={qr.data}
            state={qr.data?.state}
            instanceName={created.name}
            onRetry={() => void qr.refetch()}
            isFetching={qr.isFetching}
            isError={qr.isError}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

export function QrPane({
  qr,
  state,
  instanceName,
  onRetry,
  isFetching,
  isError,
}: {
  qr: InstanceQr | undefined;
  state: 'open' | 'connecting' | 'close' | undefined;
  instanceName: string;
  onRetry?: () => void;
  isFetching?: boolean;
  isError?: boolean;
}) {
  if (state === 'open') {
    return (
      <div className="space-y-2 text-center py-4">
        <p className="text-lg font-medium text-green-600">Conectado!</p>
        <p className="text-sm text-[var(--foreground-muted)]">
          <strong>{instanceName}</strong> pareado com sucesso.
        </p>
      </div>
    );
  }

  const qrBase64 = qr?.qrBase64;
  const pairingCode = qr?.pairingCode;

  const imgSrc = qrBase64
    ? qrBase64.startsWith('data:image')
      ? qrBase64
      : `data:image/png;base64,${qrBase64}`
    : null;

  const formattedCode = pairingCode
    ? pairingCode.replace(/(.{4})(?=.)/g, '$1-')
    : null;

  const isUnavailable = !imgSrc && (state === 'close' || isError);

  // Why the session dropped, mapped server-side from the Baileys reason code.
  // Present only while not connected, so the operator knows what happened
  // (e.g. WhatsApp anti-spam logout after a cold bulk) and what to do next.
  const reason = qr?.disconnectionReason;

  return (
    <div className="space-y-3 text-center">
      {reason && (
        <div
          role="alert"
          className="rounded-md border border-amber-400 bg-amber-50 p-3 text-left dark:border-amber-700 dark:bg-amber-950/40"
        >
          <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
            Motivo da desconexão: {reason.message}
          </p>
          <p className="mt-1 text-xs text-amber-800 dark:text-amber-300">{reason.guidance}</p>
        </div>
      )}

      <p className="text-xs text-[var(--foreground-muted)]">
        Abra WhatsApp → Aparelhos vinculados → Vincular aparelho
      </p>

      {imgSrc ? (
        <img
          src={imgSrc}
          alt="QR code para parear o WhatsApp"
          className="mx-auto block size-64"
        />
      ) : isUnavailable ? (
        <div className="py-6 space-y-3">
          <p className="text-sm text-[var(--foreground-muted)]">
            Código QR temporariamente indisponível. Aguarde a inicialização da instância ou tente novamente.
          </p>
          {onRetry && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onRetry}
              disabled={isFetching}
            >
              {isFetching ? 'Buscando…' : 'Tentar novamente'}
            </Button>
          )}
        </div>
      ) : (
        <p className="text-sm text-[var(--foreground-muted)] py-8">Gerando código…</p>
      )}

      {formattedCode && (
        <p className="font-mono text-sm tracking-wider">
          Código alternativo: <strong>{formattedCode}</strong>
        </p>
      )}

      <p className="text-xs text-[var(--foreground-muted)]">
        Aguardando pareamento de <strong>{instanceName}</strong>…
      </p>
    </div>
  );
}
