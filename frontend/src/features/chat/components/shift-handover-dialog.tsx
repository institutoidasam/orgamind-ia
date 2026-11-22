import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useAuthStore } from '@/stores/auth.store';
import { useChatAssignees } from '../api';
import { handoverSkipText, useHandoverConversations, useShiftHandover, type ShiftHandoverResult } from '../handover-api';
import type { ConversationSummary } from '../schemas';

const NOTE_MAX = 200;

type Target = { id: string; name: string };
type Skipped = { id: string; label: string; text: string };
type QueryStatus = { isLoading: boolean; isError: boolean };

/** Linhas do resultado: o contato como a tela mostrava ao confirmar e o motivo (DT9). */
function skippedRows(result: ShiftHandoverResult, names: Map<string, string>, targetName: string): Skipped[] {
  return result.skipped.map((s) => ({
    id: s.id,
    label: names.get(s.id) ?? 'Conversa',
    text: handoverSkipText(s.reason, targetName),
  }));
}

function targetsHint({ isLoading, isError }: QueryStatus, count: number): string | null {
  if (isLoading) return 'Carregando…';
  if (isError) return 'Não foi possível carregar a lista.';
  return count === 0 ? 'Ninguém disponível.' : null;
}

/**
 * Estado do diálogo: lista de quem sai (todas marcadas; só as desmarcadas ficam no estado, porque a lista chega
 * depois), destino, observação e o resultado com puladas. `fromUserId` só vai no corpo quando não é quem olha (K3-2).
 */
function useHandoverDraft(fromId: string, onClose: () => void) {
  const meId = useAuthStore((s) => s.user?.id);
  const list = useHandoverConversations(fromId, true);
  const assignees = useChatAssignees(true);
  const shift = useShiftHandover();
  const [unchecked, setUnchecked] = useState<ReadonlySet<string>>(new Set());
  const [pickedId, setPickedId] = useState('');
  const [note, setNote] = useState('');
  const [skipped, setSkipped] = useState<Skipped[] | null>(null);
  const items = list.data?.items ?? [];
  const options: Target[] = (assignees.data?.items ?? []).filter((a) => a.id !== fromId);
  const selected = items.filter((c) => !unchecked.has(c.id));
  // Destino que a recarga de `chat/assignees` tirou (404 `user.not_found`) deixa de valer.
  const target = options.find((o) => o.id === pickedId);
  const trimmed = note.trim();

  function toggle(id: string) {
    setUnchecked((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  function confirm() {
    if (!target || selected.length === 0 || !trimmed) return;
    const names = new Map(selected.map((c) => [c.id, c.displayName]));
    const input = {
      toUserId: target.id,
      note: trimmed,
      conversationIds: selected.map((c) => c.id),
      ...(fromId === meId ? {} : { fromUserId: fromId }),
    };
    shift.mutate({ input, targetName: target.name }, {
      onSuccess: (result) => {
        const rows = skippedRows(result, names, target.name);
        if (rows.length === 0) onClose();
        else setSkipped(rows);
      },
    });
  }

  return {
    list, items, assignees, options, unchecked, toggle, pickedId: target?.id ?? '', setPickedId, note, setNote,
    skipped, confirm, ready: !!target && selected.length > 0 && trimmed.length > 0 && !shift.isPending,
  };
}

type Draft = ReturnType<typeof useHandoverDraft>;

function ConversationsSection({ d }: { d: Draft }) {
  if (d.list.isError) return <p role="alert" className="text-sm">Não foi possível carregar as conversas.</p>;
  if (d.list.isLoading) return <p className="text-sm">Carregando…</p>;
  if (d.items.length === 0) return <p className="text-sm">Nenhuma conversa em atendimento.</p>;
  const total = d.list.data?.total ?? d.items.length;
  return (
    <>
      <ul className="grid max-h-56 gap-1.5 overflow-y-auto">
        {d.items.map((c) => (
          <li key={c.id} className="flex items-center gap-2">
            <Checkbox id={`handover-${c.id}`} checked={!d.unchecked.has(c.id)} onCheckedChange={() => d.toggle(c.id)} />
            <Label htmlFor={`handover-${c.id}`}>{c.displayName}</Label>
          </li>
        ))}
      </ul>
      {total > d.items.length ? (
        <p className="text-sm" style={{ color: 'var(--foreground-muted)' }}>
          Mostrando {d.items.length} de {total}. Passe estas e abra de novo para passar as demais.
        </p>
      ) : null}
    </>
  );
}

function TargetField({ d }: { d: Draft }) {
  const hint = targetsHint(d.assignees, d.options.length);
  return (
    <div className="grid gap-2">
      <Label htmlFor="handover-target">Passar para</Label>
      <Select value={d.pickedId} onValueChange={d.setPickedId}>
        <SelectTrigger id="handover-target" aria-label="Passar para">
          <SelectValue placeholder="Escolha um colega" />
        </SelectTrigger>
        <SelectContent>
          {d.options.map((o) => <SelectItem key={o.id} value={o.id}>{o.name}</SelectItem>)}
        </SelectContent>
      </Select>
      {hint ? <p className="text-sm" style={{ color: 'var(--foreground-muted)' }}>{hint}</p> : null}
    </div>
  );
}

function NoteField({ d }: { d: Draft }) {
  return (
    <div className="grid gap-2">
      <Label htmlFor="handover-note">Observação</Label>
      <Textarea
        id="handover-note"
        maxLength={NOTE_MAX}
        value={d.note}
        onChange={(e) => d.setNote(e.target.value.slice(0, NOTE_MAX))}
      />
    </div>
  );
}

function HandoverBody({ fromId, onClose }: { fromId: string; onClose: () => void }) {
  const d = useHandoverDraft(fromId, onClose);
  if (d.skipped) {
    return (
      <>
        <div className="grid gap-2 text-sm">
          <p className="font-medium">Não foram passadas:</p>
          <ul className="grid gap-1">
            {d.skipped.map((s) => <li key={s.id}>{s.label}: {s.text}</li>)}
          </ul>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>Fechar</Button>
        </DialogFooter>
      </>
    );
  }
  return (
    <>
      <fieldset className="grid gap-2">
        <legend className="mb-1 text-sm font-medium">Conversas em atendimento</legend>
        <ConversationsSection d={d} />
      </fieldset>
      <TargetField d={d} />
      <NoteField d={d} />
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>Cancelar</Button>
        <Button type="button" disabled={!d.ready} onClick={d.confirm}>Confirmar</Button>
      </DialogFooter>
    </>
  );
}

type DialogProps = {
  open: boolean;
  /** "Passar meu turno" ou "Passar as conversas de {nome}". */
  title: string;
  /** Quem sai: as conversas "Em atendimento" dele são a lista e ele fica fora dos destinos. */
  fromId: string;
  onClose: () => void;
};

/**
 * Diálogo da passagem de turno (K3-1, K3-2): conversas de quem sai marcadas, "Passar para", "Observação"
 * obrigatória (até 200). O corpo só monta com o diálogo aberto: nada é consultado antes e cada abertura recomeça
 * (lista recarregada, tudo marcado, campos vazios). A decisão é do servidor; o resultado traz as puladas.
 */
export function ShiftHandoverDialog({ open, title, fromId, onClose }: DialogProps) {
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent showCloseButton={false} aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <HandoverBody fromId={fromId} onClose={onClose} />
      </DialogContent>
    </Dialog>
  );
}

/**
 * Cabeçalho da lista da caixa: o rótulo "inbox" e "Passar meu turno" (K3-1), sempre ação manual. Fica fora de
 * `ConversationsList` para não somar estado e ramos a ela.
 */
export function ShiftHandoverHeader() {
  const meId = useAuthStore((s) => s.user?.id);
  const [open, setOpen] = useState(false);
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="ds-eyebrow">inbox</div>
      {meId ? (
        <>
          <Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)}>Passar meu turno</Button>
          <ShiftHandoverDialog open={open} title="Passar meu turno" fromId={meId} onClose={() => setOpen(false)} />
        </>
      ) : null}
    </div>
  );
}

/**
 * "Passar as conversas de {nome}" (K3-2) no cabeçalho da conversa: só ADMIN, só quando a conversa tem atendente que
 * não é ele. Esconder não é autorizar: o servidor responde 403 `chat.not_assignee` a quem não é ADMIN.
 */
export function PassConversationsButton({ conv }: { conv: ConversationSummary }) {
  const me = useAuthStore((s) => s.user);
  const [open, setOpen] = useState(false);
  const fromId = conv.assignedUserId;
  if (me?.role !== 'ADMIN' || !fromId || fromId === me.id) return null;
  const title = `Passar as conversas de ${conv.assignedUserName ?? 'Usuário removido'}`;
  return (
    <>
      <Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)}>{title}</Button>
      <ShiftHandoverDialog open={open} title={title} fromId={fromId} onClose={() => setOpen(false)} />
    </>
  );
}
