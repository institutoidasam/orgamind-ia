import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { formatDayMonth } from '@/lib/civil-date';
import { useAuthStore } from '@/stores/auth.store';
import { useCreateTeamDispatch, useTeamPersonRoute, useTeamRoster } from '../api';
import { buildChannelGroups, receivingBySector, type ChannelGroupsResult } from '../channel-groups';
import { apiErrorCode, PACING_HINT, SKIP_REASON_LABEL, teamErrorMessage } from '../error-messages';
import type { CreateDispatchInput, DispatchResult, LeftOutPerson, SendTarget } from '../schemas';
import { ChannelGroups, NoSectorNotice, UnverifiedNotice } from './channel-groups';

const MAX_TEXT = 2000;

type Props = { open: boolean; onOpenChange: (open: boolean) => void; target: SendTarget };

type SectorTarget = Extract<SendTarget, { type: 'sector' }>;

/**
 * Corpo do POST: sempre leva a data conferida; "todos os turnos" não manda `shiftIds`,
 * "todos da lista" não manda `userIds`, `includeOff` só vai quando marcado e o filtro
 * de nível (`levelIds`, `withoutLevel`) só vai quando há filtro.
 */
function requestTarget(target: SendTarget): CreateDispatchInput['target'] {
  if (target.type === 'user') return { type: 'user', userId: target.userId };
  return {
    type: 'sector',
    sectorIds: target.sectorIds,
    date: target.date,
    ...(target.shiftIds.length > 0 ? { shiftIds: target.shiftIds } : {}),
    ...(target.userIds ? { userIds: target.userIds } : {}),
    ...(target.includeOff ? { includeOff: true } : {}),
    ...(target.levelIds.length > 0 ? { levelIds: target.levelIds } : {}),
    ...(target.withoutLevel ? { withoutLevel: true } : {}),
  };
}

function PeopleList({ title, lines }: { title: string; lines: string[] }) {
  return (
    <div className="space-y-1">
      <p className="text-sm font-medium">{title}</p>
      <ul aria-label={title} className="max-h-48 overflow-y-auto rounded-md border px-3 py-1 text-sm">
        {lines.map((line, i) => <li key={`${i}-${line}`} className="py-0.5">{line}</li>)}
      </ul>
    </div>
  );
}

const LEFT_OUT_REASON: Record<LeftOutPerson['reason'], string> = {
  unselected: 'não selecionado',
  no_phone: 'sem telefone',
};

function SectorPeople({ target }: { target: SectorTarget }) {
  const { recipients, leftOut } = target;
  return (
    <div className="space-y-3">
      <PeopleList title={`Vão receber (${recipients.length})`} lines={recipients.map((p) => p.name)} />
      {leftOut.length > 0 && (
        <PeopleList title={`Ficam de fora (${leftOut.length})`} lines={leftOut.map((p) => `${p.name} · ${LEFT_OUT_REASON[p.reason]}`)} />
      )}
    </div>
  );
}

type When = 'now' | 'shift_start';

const SHIFT_PASSED_TEXT = 'O início deste turno já passou';
const ONE_SHIFT_ONLY_TEXT = 'No início do turno só vale com um turno escolhido';

/** "No início do turno" só vale com exatamente um turno (D9); o início vem do servidor (GC5). */
function shiftStartOf(target: SendTarget): NonNullable<SectorTarget['shiftStart']> | null {
  return target.type === 'sector' && target.shiftIds.length === 1 ? (target.shiftStart ?? null) : null;
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

type RouteCheck =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; noSector: boolean; view: ChannelGroupsResult };

const NO_GROUPS: ChannelGroupsResult = { groups: [], missing: [], block: null };

type RouteData = { sectorTarget: SectorTarget | null; roster: ReturnType<typeof useTeamRoster>['data']; person: ReturnType<typeof useTeamPersonRoute>['data'] };

function readCheck({ sectorTarget, roster, person }: RouteData): RouteCheck | null {
  if (sectorTarget) {
    if (!roster) return null;
    const receiving = receivingBySector(roster.sectors, sectorTarget.recipients);
    return { status: 'ready', noSector: false, view: buildChannelGroups(roster.sectors, receiving) };
  }
  if (!person) return null;
  const { sector, channel } = person;
  if (!sector) return { status: 'ready', noSector: true, view: NO_GROUPS };
  const view = buildChannelGroups([{ sectorId: sector.id, name: sector.name, channel }], new Map([[sector.id, 1]]));
  return { status: 'ready', noSector: false, view };
}

function checkOf(isError: boolean, data: RouteData): RouteCheck {
  if (isError) return { status: 'error' };
  return readCheck(data) ?? { status: 'loading' };
}

/**
 * Por qual número cada área (ou a pessoa) envia, com o estado ao vivo. A consulta é a mesma da
 * escala da tela: reconsultar atualiza os dois. Erro, mesmo com dado antigo, vale como "não conferido".
 */
function useRouteCheck(target: SendTarget) {
  const sectorTarget = target.type === 'sector' ? target : null;
  const roster = useTeamRoster(sectorTarget?.sectorIds ?? [], sectorTarget?.date ?? '');
  const person = useTeamPersonRoute(target.type === 'user' ? target.userId : '');
  const query = sectorTarget ? roster : person;
  const check = checkOf(query.isError, { sectorTarget, roster: roster.data, person: person.data });
  return { check, checking: query.isFetching, recheck: () => { void query.refetch(); } };
}

/** Enviar agora exige tudo conferido e `open`; agendar só exige que toda área tenha número (D7). */
function sendGates(check: RouteCheck, checking: boolean) {
  if (check.status !== 'ready' || checking || check.noSector) return { now: false, schedule: false };
  const { block } = check.view;
  return { now: block === null, schedule: block !== 'missing' };
}

/** O que mudou no servidor e a prévia já não mostra: refaz a consulta de número. */
const STALE_ROUTE_CODES = new Set([
  'team_whatsapp.sector_without_number', 'team_whatsapp.no_sector',
  'team_whatsapp.channel_disconnected', 'team_whatsapp.channel_unverified',
]);

function useSendForm({ target, onOpenChange }: Pick<Props, 'target' | 'onOpenChange'>) {
  const qc = useQueryClient();
  const { check, checking, recheck } = useRouteCheck(target);
  const send = useCreateTeamDispatch();
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<When>('now');
  const gates = sendGates(check, checking);
  const hasText = text.trim() !== '' && !send.isPending;

  async function submit(when: When) {
    setError(null);
    setMode(when);
    try {
      const body = { text, target: requestTarget(target) };
      const result = await send.mutateAsync(when === 'shift_start' ? { ...body, when } : body);
      notifyDone(result, target);
      onOpenChange(false);
    } catch (err) {
      const code = await apiErrorCode(err);
      setError(teamErrorMessage(code));
      if (code && STALE_ROUTE_CODES.has(code)) {
        void qc.invalidateQueries({ queryKey: ['team-whatsapp', target.type === 'user' ? 'person-route' : 'roster'] });
      }
    }
  }
  return {
    check, recheck, text, setText, error, pending: send.isPending, mode, submit,
    canSendNow: hasText && gates.now, canSchedule: hasText && gates.schedule,
  };
}

function RoutePreview({ form }: { form: ReturnType<typeof useSendForm> }) {
  const isAdmin = useAuthStore((s) => s.user?.role === 'ADMIN');
  const { check, recheck } = form;
  if (check.status === 'loading') return <p className="text-sm text-muted-foreground">Conferindo o número…</p>;
  if (check.status === 'error') return <UnverifiedNotice onRecheck={recheck} />;
  if (check.noSector) return <NoSectorNotice />;
  return <ChannelGroups view={check.view} isAdmin={isAdmin} onRecheck={recheck} />;
}

type FooterProps = { form: ReturnType<typeof useSendForm>; target: SendTarget; onClose: () => void };

type ScheduleOption = { show: boolean; blocked: boolean; note: string | null };

/** "No início do turno": um turno com início conhecido; com vários aparece bloqueado, com o motivo (D9). */
function scheduleOption(target: SendTarget): ScheduleOption {
  const start = shiftStartOf(target);
  if (start) {
    const passed = hasStarted(start.startsAt);
    return { show: true, blocked: passed, note: passed ? SHIFT_PASSED_TEXT : null };
  }
  const several = target.type === 'sector' && target.shiftIds.length > 1;
  return { show: several, blocked: true, note: several ? ONE_SHIFT_ONLY_TEXT : null };
}

function DialogActions({ form, target, onClose }: FooterProps) {
  const option = scheduleOption(target);
  return (
    <>
      {option.note && <p className="w-full text-sm text-muted-foreground">{option.note}</p>}
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>Cancelar</Button>
        {option.show && (
          <Button variant="secondary" disabled={!form.canSchedule || option.blocked} onClick={() => form.submit('shift_start')}>
            {form.pending && form.mode === 'shift_start' ? 'Agendando...' : 'No início do turno'}
          </Button>
        )}
        <Button disabled={!form.canSendNow} onClick={() => form.submit('now')}>
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
          <RoutePreview form={form} />
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
