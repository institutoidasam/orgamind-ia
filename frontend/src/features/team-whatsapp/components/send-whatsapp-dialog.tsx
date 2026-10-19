import { useState } from 'react';
import { HTTPError } from 'ky';
import { toast } from 'sonner';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { formatPhoneBR } from '@/lib/format-phone';
import { useCreateTeamDispatch, useTeamTargets } from '../api';
import { channelAvailability } from '../channel-availability';
import { PACING_HINT, SKIP_REASON_LABEL, TARGETS_ERROR_MESSAGE, teamErrorMessage } from '../error-messages';
import type { DispatchResult, SendTarget, TeamChannel } from '../schemas';

const MAX_TEXT = 2000;

type Props = { open: boolean; onOpenChange: (open: boolean) => void; target: SendTarget };

function targetLabel(target: SendTarget): string {
  return target.type === 'sector'
    ? `Setor ${target.label} · ${target.recipientCount} pessoa(s)`
    : target.label;
}

async function errorCode(err: unknown): Promise<string | undefined> {
  if (!(err instanceof HTTPError)) return undefined;
  const body = (await err.response.clone().json().catch(() => null)) as { code?: string } | null;
  return body?.code;
}

function notifyQueued(result: DispatchResult) {
  const skipped = result.skipped.map((s) => `${s.name}: ${SKIP_REASON_LABEL[s.reason]}`);
  toast.success(`Mensagem enfileirada para ${result.queued} pessoa(s)`, {
    description: [PACING_HINT, ...skipped].join('\n'),
    // sonner não preserva '\n' por padrão; escopo local, sem mexer no Toaster global.
    classNames: { description: 'whitespace-pre-line' },
  });
}

const NO_CONNECTED_CHANNEL = 'Nenhum canal conectado — reconecte em Números e canais.';

type ChannelsStatus = 'loading' | 'error' | 'ready';

function channelsStatusOf(q: { isLoading: boolean; isError: boolean }): ChannelsStatus {
  if (q.isLoading) return 'loading';
  return q.isError ? 'error' : 'ready';
}

/** Utilizáveis primeiro (ordem estável); os demais aparecem desabilitados com a situação. */
function orderChannels(channels: TeamChannel[]) {
  const usable = channels.filter((c) => channelAvailability(c).usable);
  const unusable = channels.filter((c) => !channelAvailability(c).usable);
  return { usable, ordered: [...usable, ...unusable] };
}

/**
 * Só resolve para canal utilizável. O canal escolhido que deixou de ser
 * utilizável (refetch) não é trocado em silêncio por outro: fica vazio.
 */
function resolveChannelId(usable: TeamChannel[], picked: string): string {
  if (picked) return usable.some((c) => c.id === picked) ? picked : '';
  return usable.length === 1 ? usable[0].id : '';
}

function channelLabel(c: TeamChannel): string {
  const base = `${c.name} · ${formatPhoneBR(c.phoneE164)}`;
  const availability = channelAvailability(c);
  return availability.usable ? base : `${base} · ${availability.label}`;
}

function useSendForm({ target, onOpenChange }: Pick<Props, 'target' | 'onOpenChange'>) {
  const targets = useTeamTargets();
  const { usable, ordered: channels } = orderChannels(targets.data?.channels ?? []);
  const channelsStatus = channelsStatusOf(targets);
  const send = useCreateTeamDispatch();
  const [picked, setPicked] = useState('');
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const channelId = resolveChannelId(usable, picked);
  const canSend = channelsStatus === 'ready' && !!channelId && text.trim() !== '' && !send.isPending;

  async function submit() {
    setError(null);
    try {
      const body = target.type === 'sector'
        ? ({ type: 'sector', sectorId: target.sectorId } as const)
        : ({ type: 'user', userId: target.userId } as const);
      notifyQueued(await send.mutateAsync({ channelId, text, target: body }));
      onOpenChange(false);
    } catch (err) {
      setError(teamErrorMessage(await errorCode(err)));
    }
  }
  return { channels, hasUsable: usable.length > 0, channelsStatus, channelId, setPicked, text, setText, error, canSend, pending: send.isPending, submit };
}

type ChannelSelectProps = {
  channels: TeamChannel[];
  hasUsable: boolean;
  status: ChannelsStatus;
  value: string;
  onChange: (id: string) => void;
};

function ChannelSelect({ channels, hasUsable, status, value, onChange }: ChannelSelectProps) {
  if (status === 'loading') {
    return <p className="text-sm text-muted-foreground">Carregando canais…</p>;
  }
  if (status === 'error') {
    return <p role="alert" className="text-sm text-destructive">{TARGETS_ERROR_MESSAGE}</p>;
  }
  if (channels.length === 0) {
    return <p className="text-sm text-muted-foreground">Nenhum canal GoZap ou Evolution ativo.</p>;
  }
  return (
    <div className="space-y-2">
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger aria-label="Canal"><SelectValue placeholder="Escolha o canal" /></SelectTrigger>
        <SelectContent>
          {channels.map((c) => (
            <SelectItem key={c.id} value={c.id} disabled={!channelAvailability(c).usable}>{channelLabel(c)}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      {!hasUsable && <p className="text-sm text-muted-foreground">{NO_CONNECTED_CHANNEL}</p>}
    </div>
  );
}

export function SendWhatsappDialog({ open, onOpenChange, target }: Props) {
  const form = useSendForm({ target, onOpenChange });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Enviar WhatsApp</DialogTitle>
          <DialogDescription>{targetLabel(target)}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Canal</Label>
            <ChannelSelect channels={form.channels} hasUsable={form.hasUsable} status={form.channelsStatus} value={form.channelId} onChange={form.setPicked} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="team-whatsapp-text">Mensagem</Label>
            <Textarea id="team-whatsapp-text" rows={5} maxLength={MAX_TEXT} value={form.text} onChange={(e) => form.setText(e.target.value)} />
            <p className="text-right text-xs text-muted-foreground">{form.text.length}/{MAX_TEXT}</p>
          </div>
          {form.error && <p role="alert" className="text-sm text-destructive">{form.error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancelar</Button>
          <Button disabled={!form.canSend} onClick={form.submit}>{form.pending ? 'Enviando...' : 'Enviar'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
