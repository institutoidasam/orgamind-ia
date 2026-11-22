import { useState } from 'react';
import { toast } from 'sonner';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { readApiErrorBody } from '@/lib/api-error';
import { useRemoveDisabledChannel, type DisabledChannel } from '../api';
import { DISABLED_PROVIDER_LABEL } from '../disabled-provider';

function areasText(sectorNames: readonly string[]): string {
  return sectorNames.length > 0 ? `Áreas: ${sectorNames.join(', ')}` : 'Nenhuma área';
}

/** GC11: a frase da confirmação (o título traz `Remover <nome>?`; o resto vem daqui). */
function confirmationText(channel: DisabledChannel): string {
  const provider = DISABLED_PROVIDER_LABEL[channel.provider];
  const kept = `A conexão no ${provider} não é apagada por aqui.`;
  if (channel.sectorNames.length === 0) return kept;
  return `As áreas ${channel.sectorNames.join(', ')} ficam sem número até serem ligadas a um número Evolution. ${kept}`;
}

/**
 * Confirmação simples (sem digitar o nome): a remoção só desativa o número aqui
 * e solta as áreas — a conexão no provedor desligado não é tocada. A
 * autorização é do back (`@Roles('ADMIN')`); o front só esconde o bloco.
 */
function RemoveDisabledChannelDialog({ channel, onClose }: { channel: DisabledChannel | null; onClose: () => void }) {
  const remove = useRemoveDisabledChannel();
  if (!channel) return null;

  const confirm = async () => {
    try {
      await remove.mutateAsync(channel.id);
      toast.success('Número removido');
      onClose();
    } catch (err) {
      const body = await readApiErrorBody(err);
      toast.error(body?.title ?? body?.detail ?? 'Não foi possível remover o número');
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{`Remover ${channel.name}?`}</DialogTitle>
          <DialogDescription>{confirmationText(channel)}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>Cancelar</Button>
          <Button type="button" variant="destructive" disabled={remove.isPending} onClick={confirm}>
            Remover
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DisabledChannelRow({ channel, onRemove }: { channel: DisabledChannel; onRemove: () => void }) {
  return (
    <div className="flex items-center gap-3 rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-3">
      <div className="min-w-0 flex-1">
        <strong className="block truncate text-sm">{channel.name}</strong>
        <div className="truncate text-xs text-[var(--foreground-muted)]">{channel.phoneE164 ?? '—'}</div>
        <div className="truncate text-xs text-[var(--foreground-muted)]">
          {`Integração: ${DISABLED_PROVIDER_LABEL[channel.provider]}`}
        </div>
        <div className="truncate text-xs text-[var(--foreground-muted)]">{areasText(channel.sectorNames)}</div>
      </div>
      <button
        type="button"
        className="rounded border border-[var(--border)] px-2 py-1 text-xs text-destructive"
        onClick={onRemove}
        aria-label={`Remover ${channel.name}`}
      >
        Remover
      </button>
    </div>
  );
}

/**
 * R13: números de integrações desligadas que ainda existem no banco (só o ADMIN
 * recebe a lista). Dão ao ADMIN o caminho de tirar o número (soltar as áreas e
 * falhar o que estava parado); não reativam nada.
 */
export function DisabledChannelsSection({ channels }: { channels: DisabledChannel[] }) {
  const [target, setTarget] = useState<DisabledChannel | null>(null);
  return (
    <section className="space-y-3">
      <h2 className="text-base font-semibold">Números desligados</h2>
      <div className="space-y-2">
        {channels.map((ch) => (
          <DisabledChannelRow key={ch.id} channel={ch} onRemove={() => setTarget(ch)} />
        ))}
      </div>
      <RemoveDisabledChannelDialog channel={target} onClose={() => setTarget(null)} />
    </section>
  );
}
