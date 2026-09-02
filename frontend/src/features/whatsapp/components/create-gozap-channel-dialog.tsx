import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Checkbox } from '@/components/ui/checkbox';
import { extractApiError } from '@/lib/api-error';
import { useCreateGozapChannel, type ChannelSummary } from '../api';

const createGozapChannelInputSchema = z.object({
  name: z.string().min(2, 'Nome muito curto').max(80, 'Nome muito longo'),
});
type CreateGozapChannelInput = z.infer<typeof createGozapChannelInputSchema>;

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (channel: ChannelSummary) => void;
};

/**
 * Cria o CANAL GOZAP — POST /whatsapp/channels com `{ provider: 'GOZAP', name }`
 * apenas: GOZAP provisiona EXTERNAMENTE (cria a instância no lado do GoZap,
 * cifra o token, arma o webhook), diferente dos outros provedores cloud
 * (CreateChannelForm) que só registram uma row para um número já vivo. Por
 * isso este form não pede telefone nem id de conta — o número só é conhecido
 * depois do pareamento por QR, que acontece a seguir no GozapQrDialog
 * (`onCreated` devolve o canal para o pai abrir o dialog de QR).
 *
 * ⚠️ A conta GoZap de produção é do plano BÁSICO — LIMITE DE 1 INSTÂNCIA.
 * Criar uma segunda instância dá 502 no GoZap e pode derrubar a instância que
 * já funciona (visto em produção). O backend não tem como recusar isso hoje
 * (o limite é do plano contratado, não uma regra do orgamind) — então o aviso e
 * a confirmação explícita (checkbox) são a única trava que existe. Sem
 * marcar a caixa, o botão "Criar canal" fica desabilitado.
 */
export function CreateGozapChannelDialog({ open, onOpenChange, onCreated }: Props) {
  const [backendError, setBackendError] = useState<string | null>(null);
  const [ackRisk, setAckRisk] = useState(false);
  const form = useForm<CreateGozapChannelInput>({
    resolver: zodResolver(createGozapChannelInputSchema),
    defaultValues: { name: '' },
  });
  const create = useCreateGozapChannel();

  const handleOpenChange = (next: boolean) => {
    if (!next) {
      form.reset({ name: '' });
      setBackendError(null);
      setAckRisk(false);
    }
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Nova conexão GoZap</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={form.handleSubmit(async (input) => {
            setBackendError(null);
            try {
              const channel = await create.mutateAsync(input);
              form.reset({ name: '' });
              setAckRisk(false);
              onCreated(channel);
            } catch (err) {
              // Same convention as CreateChannelForm: `title` carries the
              // DomainError's PT-BR phrase (e.g. "Já existe um canal GoZap
              // ativo chamado ..."); shown inline, not as a toast, so it
              // stays visible while the operator fixes the name.
              const { title } = await extractApiError(err);
              setBackendError(title);
            }
          })}
          className="space-y-3"
        >
          <Alert variant="destructive">
            <AlertTitle>Atenção: o plano permite só 1 instância</AlertTitle>
            <AlertDescription>
              Esta conta GoZap é do plano Básico (limite de 1 instância). Se já
              existe uma conexão funcionando, criar outra pode falhar (erro 502)
              <strong> e derrubar a conexão que já está no ar</strong>. Só crie uma
              nova conexão se tiver certeza — por exemplo, para substituir a
              atual.
            </AlertDescription>
          </Alert>

          {backendError && (
            <Alert variant="destructive">
              <AlertTitle>Não foi possível criar o canal</AlertTitle>
              <AlertDescription className="whitespace-pre-line">
                {backendError}
              </AlertDescription>
            </Alert>
          )}

          <div className="space-y-1">
            <Label htmlFor="gozap-channel-name">Nome de exibição</Label>
            <Input id="gozap-channel-name" {...form.register('name')} />
            {form.formState.errors.name && (
              <p className="text-xs text-destructive">{form.formState.errors.name.message}</p>
            )}
          </div>

          <div className="flex items-start gap-2">
            <Checkbox
              id="gozap-ack-risk"
              checked={ackRisk}
              onCheckedChange={(checked) => setAckRisk(checked === true)}
            />
            <Label htmlFor="gozap-ack-risk" className="text-xs font-normal">
              Entendo o risco do limite de 1 instância e quero criar uma nova
              conexão mesmo assim.
            </Label>
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => handleOpenChange(false)}>
              Cancelar
            </Button>
            <Button
              type="submit"
              disabled={create.isPending || !ackRisk}
              title={!ackRisk ? 'Marque a caixa confirmando que entende o limite do plano' : undefined}
            >
              {create.isPending ? 'Criando…' : 'Criar canal'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
