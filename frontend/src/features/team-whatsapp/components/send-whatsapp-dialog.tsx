import { useState } from 'react';
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
import { formatDayMonth } from '@/lib/civil-date';
import { formatPhoneBR } from '@/lib/format-phone';
import { useCreateTeamDispatch, useTeamTargets } from '../api';
import { channelAvailability } from '../channel-availability';
import {
  apiErrorCode, PACING_HINT, SKIP_REASON_LABEL, TARGETS_ERROR_MESSAGE, teamErrorMessage,
} from '../error-messages';
import type { CreateDispatchInput, DispatchResult, RecipientPreview, SendTarget, TeamChannel } from '../schemas';

const MAX_TEXT = 2000;

type Props = { open: boolean; onOpenChange: (open: boolean) => void; target: SendTarget };

type SectorTarget = Extract<SendTarget, { type: 'sector' }>;

/**
 * Corpo do POST: sempre leva a data conferida; "todos os turnos" não manda `shiftId`,
 * "todos da lista" não manda `userIds`, `includeOff` só vai quando marcado e o filtro
 * de nível (`levelIds`, `withoutLevel`) só vai quando há filtro.
 */
function requestTarget(target: SendTarget): CreateDispatchInput['target'] {
  if (target.type === 'user') return { type: 'user', userId: target.userId };
  return {
    type: 'sector',
    sectorIds: target.sectorIds,
    date: target.date,
    ...(target.shiftId ? { shiftId: target.shiftId } : {}),
    ...(target.userIds ? { userIds: target.userIds } : {}),
    ...(target.includeOff ? { includeOff: true } : {}),
    ...(target.levelIds.length > 0 ? { levelIds: target.levelIds } : {}),
    ...(target.withoutLevel ? { withoutLevel: true } : {}),
  };
}

function PeopleList({ title, people }: { title: string; people: RecipientPreview[] }) {
  return (
    <div className="space-y-1">
      <p className="text-sm font-medium">{title}</p>
      <ul aria-label={title} className="max-h-48 overflow-y-auto rounded-md border px-3 py-1 text-sm">
        {people.map((p) => <li key={p.id} className="py-0.5">{p.name}</li>)}
      </ul>
    </div>
  );
}

function SectorPeople({ target }: { target: SectorTarget }) {
  return (
    <div className="space-y-3">
      <PeopleList title={`Vão receber (${target.recipients.length})`} people={target.recipients} />
      {target.leftOut.length > 0 && <PeopleList title="Ficam de fora (sem telefone)" people={target.leftOut} />}
    </div>
  );
}

type When = 'now' | 'shift_start';

const SHIFT_PASSED_TEXT = 'O início deste turno já passou';

/** "No início do turno" só existe com turno específico; o início vem do servidor (GC5). */
function shiftStartOf(target: SendTarget): NonNullable<SectorTarget['shiftStart']> | null {
  return target.type === 'sector' && target.shiftId ? (target.shiftStart ?? null) : null;
}

const hasStarted = (startsAt: string) => Date.parse(startsAt) <= Date.now();

function notifyDone(result: DispatchResult, target: SendTarget) {
  const skipped = result.skipped.map((s) => `${s.name}: ${SKIP_REASON_LABEL[s.reason]}`);
  const sector = target.type === 'sector' ? target : null;
  const scheduled = result.scheduled > 0 && sector?.shiftStart;
  const title = scheduled && sector
    ? `Agendado para ${formatDayMonth(sector.date)} às ${sector.shiftStart?.startTime}`
    : `Mensagem enfileirada para ${result.queued} pessoa(s)`;
  toast.success(title, {
    description: [...(scheduled ? [] : [PACING_HINT]), ...skipped].join('\n'),
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
  const [mode, setMode] = useState<When>('now');
  const channelId = resolveChannelId(usable, picked);
  const canSend = channelsStatus === 'ready' && !!channelId && text.trim() !== '' && !send.isPending;

  async function submit(when: When) {
    setError(null);
    setMode(when);
    try {
      const body = { channelId, text, target: requestTarget(target) };
      const result = await send.mutateAsync(when === 'shift_start' ? { ...body, when } : body);
      notifyDone(result, target);
      onOpenChange(false);
    } catch (err) {
      setError(teamErrorMessage(await apiErrorCode(err)));
    }
  }
  return { channels, hasUsable: usable.length > 0, channelsStatus, channelId, setPicked, text, setText, error, canSend, pending: send.isPending, mode, submit };
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

type FooterProps = { form: ReturnType<typeof useSendForm>; target: SendTarget; onClose: () => void };

function DialogActions({ form, target, onClose }: FooterProps) {
  const start = shiftStartOf(target);
  const passed = start !== null && hasStarted(start.startsAt);
  return (
    <>
      {passed && <p className="w-full text-sm text-muted-foreground">{SHIFT_PASSED_TEXT}</p>}
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>Cancelar</Button>
        {start && (
          <Button variant="secondary" disabled={!form.canSend || passed} onClick={() => form.submit('shift_start')}>
            {form.pending && form.mode === 'shift_start' ? 'Agendando...' : 'No início do turno'}
          </Button>
        )}
        <Button disabled={!form.canSend} onClick={() => form.submit('now')}>
          {form.pending && form.mode === 'now' ? 'Enviando...' : 'Enviar agora'}
        </Button>
      </DialogFooter>
    </>
  );
}

export function SendWhatsappDialog({ open, onOpenChange, target }: Props) {
  const form = useSendForm({ target, onOpenChange });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Enviar WhatsApp</DialogTitle>
          <DialogDescription>{target.label}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {target.type === 'sector' && <SectorPeople target={target} />}
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
        <DialogActions form={form} target={target} onClose={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}
