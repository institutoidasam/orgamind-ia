import { useState } from 'react';
import { useForm, type UseFormReturn } from 'react-hook-form';
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
import { useAreaChoice } from '../use-area-choice';
import { MoveConfirmation, SectorPicker } from './sector-picker';

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
 * Cria o CANAL GOZAP — POST /whatsapp/channels com `{ provider: 'GOZAP', name,
 * sectorIds }` (as áreas que o número atende; área que já tem outro número pede
 * confirmação antes de criar): GOZAP provisiona EXTERNAMENTE (cria a instância no lado do GoZap,
 * cifra o token, arma o webhook), diferente dos outros provedores cloud
 * (CreateChannelForm) que só registram uma row para um número já vivo. Por
 * isso este form não pede telefone nem id de conta — o número só é conhecido
 * depois do pareamento por QR, que acontece a seguir no GozapQrDialog
 * (`onCreated` devolve o canal para o pai abrir o dialog de QR).
 *
 * ⚠️ A conta GoZap de produção é do plano BÁSICO — LIMITE DE 1 INSTÂNCIA.
 * Criar uma segunda instância dá 502 no GoZap e pode derrubar a instância que
 * já funciona (visto em produção). Desde 23/10/2026 o backend confere a vaga
 * da conta (`GET /instance/all` × `GOZAP_MAX_INSTANCES`) ANTES de criar e
 * recusa com `gozap.instance_limit_reached` (409), listando o que ocupa as
 * vagas — ou com `gozap.capacity_check_failed` (502) quando não consegue
 * consultar. Essas recusas, como as demais, chegam pela frase PT-BR do
 * backend (`title`, lido de `HTTPError.data` por `extractApiError` →
 * `readApiErrorBody`) no alerta inline. O aviso e a confirmação explícita
 * (checkbox) continuam como segunda trava: o limite configurado pode não
 * refletir o plano contratado. Sem marcar a caixa, o botão "Criar canal" fica
 * desabilitado.
 */
function useGozapCreate(areas: ReturnType<typeof useAreaChoice>, onCreated: Props['onCreated']) {
  const [backendError, setBackendError] = useState<string | null>(null);
  const [ackRisk, setAckRisk] = useState(false);
  const form = useForm<CreateGozapChannelInput>({
    resolver: zodResolver(createGozapChannelInputSchema),
    defaultValues: { name: '' },
  });
  const create = useCreateGozapChannel();

  const reset = () => {
    form.reset({ name: '' });
    setBackendError(null);
    setAckRisk(false);
    areas.reset();
  };

  const submit = form.handleSubmit((input) =>
    areas.proceed(async () => {
      setBackendError(null);
      try {
        const channel = await create.mutateAsync({ ...input, sectorIds: areas.selected });
        reset();
        onCreated(channel);
      } catch (err) {
        // Same convention as CreateChannelForm: `title` carries the
        // DomainError's PT-BR phrase (e.g. "Já existe um canal GoZap
        // ativo chamado ..."); shown inline, not as a toast, so it
        // stays visible while the operator fixes the name.
        areas.dismiss();
        const { title } = await extractApiError(err);
        setBackendError(title);
      }
    }),
  );

  return { form, create, submit, reset, backendError, ack: { checked: ackRisk, onChange: setAckRisk } };
}

export function CreateGozapChannelDialog({ open, onOpenChange, onCreated }: Props) {
  const areas = useAreaChoice(null);
  const flow = useGozapCreate(areas, onCreated);

  const handleOpenChange = (next: boolean) => {
    if (!next) flow.reset();
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Nova conexão GoZap</DialogTitle>
        </DialogHeader>
        {areas.confirming ? (
          <MoveConfirmation
            moves={areas.moves}
            pending={flow.create.isPending}
            onConfirm={() => void flow.submit()}
            onCancel={areas.dismiss}
          />
        ) : (
          <GozapForm
            form={flow.form}
            areas={areas}
            ack={flow.ack}
            error={flow.backendError}
            pending={flow.create.isPending}
            onSubmit={flow.submit}
            onCancel={() => handleOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

type GozapFormProps = {
  form: UseFormReturn<CreateGozapChannelInput>;
  areas: ReturnType<typeof useAreaChoice>;
  ack: { checked: boolean; onChange: (checked: boolean) => void };
  error: string | null;
  pending: boolean;
  onSubmit: () => void;
  onCancel: () => void;
};

function PlanLimitAlert() {
  return (
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
  );
}

function AckRiskField({ checked, onChange }: GozapFormProps['ack']) {
  return (
    <div className="flex items-start gap-2">
      <Checkbox id="gozap-ack-risk" checked={checked} onCheckedChange={(next) => onChange(next === true)} />
      <Label htmlFor="gozap-ack-risk" className="text-xs font-normal">
        Entendo o risco do limite de 1 instância e quero criar uma nova
        conexão mesmo assim.
      </Label>
    </div>
  );
}

function GozapForm({ form, areas, ack, error, pending, onSubmit, onCancel }: GozapFormProps) {
  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <PlanLimitAlert />

      {error && (
        <Alert variant="destructive">
          <AlertTitle>Não foi possível criar o canal</AlertTitle>
          <AlertDescription className="whitespace-pre-line">{error}</AlertDescription>
        </Alert>
      )}

      <div className="space-y-1">
        <Label htmlFor="gozap-channel-name">Nome de exibição</Label>
        <Input id="gozap-channel-name" {...form.register('name')} />
        {form.formState.errors.name && (
          <p className="text-xs text-destructive">{form.formState.errors.name.message}</p>
        )}
      </div>

      <SectorPicker
        sectors={areas.sectors}
        value={areas.selected}
        loading={areas.loading}
        onChange={areas.setSelected}
      />
      <AckRiskField {...ack} />

      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancelar
        </Button>
        <Button
          type="submit"
          disabled={pending || !ack.checked}
          title={!ack.checked ? 'Marque a caixa confirmando que entende o limite do plano' : undefined}
        >
          {pending ? 'Criando…' : 'Criar canal'}
        </Button>
      </DialogFooter>
    </form>
  );
}
