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
import { AUDIENCE_PREVIEW_KEY, useCreateTeamDispatch, useTeamPersonRoute, useTeamRoster } from '../api';
import { buildChannelGroups, type ChannelGroupsResult } from '../channel-groups';
import { apiErrorCode, apiErrorText, PACING_HINT, SKIP_REASON_LABEL, teamErrorMessage } from '../error-messages';
import { receivingByArea } from '../member-filter';
import { PURPOSE_RULES } from '../purpose';
import type {
  CreateDispatchInput, DispatchResult, SendTarget, TeamActivity, TeamAudiencePreview, TeamPurpose,
} from '../schemas';
import { ChannelGroups, NoSectorNotice, UnverifiedNotice } from './channel-groups';
import { ExcludedGroups } from './excluded-groups';
import { RulePanel } from './rule-panel';

const MAX_TEXT = 2000;

/** A prévia que a tela mostra agora (a viva) e se é a do corpo atual (`isFresh`, T14): só então o envio libera. */
export type SendAudience = { preview: TeamAudiencePreview; isFresh: boolean };

type SectorTarget = Extract<SendTarget, { type: 'sector' }>;
type UserTarget = Extract<SendTarget, { type: 'user' }>;

type Props = { open: boolean; onOpenChange: (open: boolean) => void } & (
  | { target: UserTarget; audience?: undefined }
  | { target: SectorTarget; audience: SendAudience }
);

type FormArgs = { target: SendTarget; audience: SendAudience | undefined; onOpenChange: (open: boolean) => void };

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

/** Revisão do público (C4): a regra como o servidor a aplicou, quem recebe e quem fica de fora, com o motivo. */
function AudienceReview({ preview }: { preview: TeamAudiencePreview }) {
  const { rule, included, excluded } = preview;
  return (
    <div className="space-y-3">
      <RulePanel rule={rule} includedCount={included.length} excludedCount={excluded.length} />
      <PeopleList title={`Vão receber (${included.length})`} lines={included.map((p) => p.name)} />
      <div className="max-h-60 overflow-y-auto">
        <ExcludedGroups excluded={excluded} title="Ficam de fora" />
      </div>
    </div>
  );
}

type Block = TeamAudiencePreview['blocks'][number];

const EMPTY_TEXT_CODE = 'team_whatsapp.empty_text';
const AUDIENCE_CHANGED_CODE = 'team_whatsapp.audience_changed';

/**
 * Travas perto do botão, na ordem do servidor (CF4). A prévia vai com `text: ''` (DF11): a trava do texto sai da
 * lista dela e é conferida aqui, com o mesmo texto e na mesma posição (a primeira).
 */
function sendBlocks(preview: TeamAudiencePreview, text: string): Block[] {
  const fromServer = preview.blocks.filter((b) => b.code !== EMPTY_TEXT_CODE);
  if (text.trim() !== '') return fromServer;
  return [{ code: EMPTY_TEXT_CODE, message: teamErrorMessage(EMPTY_TEXT_CODE) }, ...fromServer];
}

type AudienceFields = Pick<CreateDispatchInput, 'purpose' | 'base' | 'activity' | 'urgencyReason' | 'audienceKey'>;

/** Atividade que a prévia aplicou, de volta no formato do corpo: só o que veio preenchido. */
function activityInput({ date, time, place }: TeamActivity): NonNullable<CreateDispatchInput['activity']> {
  return { ...(date ? { date } : {}), ...(time ? { time } : {}), ...(place ? { place } : {}) };
}

/** Finalidade, base, atividade e motivo da regra da prévia vista, mais a impressão dela (`audienceKey`, CF2). */
function audienceFields({ preview }: SendAudience): AudienceFields {
  const { rule, audienceKey } = preview;
  const activity = rule.activity ? activityInput(rule.activity) : null;
  return {
    purpose: rule.purpose,
    base: rule.base,
    audienceKey,
    ...(activity && Object.keys(activity).length > 0 ? { activity } : {}),
    ...(rule.urgencyReason ? { urgencyReason: rule.urgencyReason } : {}),
  };
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

type RouteData = {
  sectorTarget: SectorTarget | null;
  roster: ReturnType<typeof useTeamRoster>['data'];
  person: ReturnType<typeof useTeamPersonRoute>['data'];
  /** Quantas pessoas recebem em cada área (`sectorId` -> n). */
  receiving: ReadonlyMap<string, number>;
};

function readCheck({ sectorTarget, roster, person, receiving }: RouteData): RouteCheck | null {
  if (sectorTarget) {
    if (!roster) return null;
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
 * Quantas pessoas recebem em cada área: pela área que o servidor manda (`sectorId` da prévia, CF3), não pelo quadro
 * da escala. Remanejado conta uma vez, na área da prévia.
 */
function receivingCounts(audience: SendAudience | undefined): Map<string, number> {
  const groups = audience ? receivingByArea(audience.preview) : [];
  return new Map(groups.map((g) => [g.sectorId, g.people.length]));
}

/**
 * Por qual número cada área (ou a pessoa) envia, com o estado ao vivo. A consulta é a mesma da
 * escala da tela: reconsultar atualiza os dois. Erro, mesmo com dado antigo, vale como "não conferido".
 * A escala só dá o número da área e o estado dele; quem conta em cada área é a prévia.
 */
function useRouteCheck(target: SendTarget, audience: SendAudience | undefined) {
  const sectorTarget = target.type === 'sector' ? target : null;
  const roster = useTeamRoster(sectorTarget?.sectorIds ?? [], sectorTarget?.date ?? '');
  const person = useTeamPersonRoute(target.type === 'user' ? target.userId : '');
  const query = sectorTarget ? roster : person;
  const receiving = receivingCounts(audience);
  const check = checkOf(query.isError, { sectorTarget, roster: roster.data, person: person.data, receiving });
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

/**
 * Envio e recusas. 409 `audience_changed`: fecha a confirmação, avisa com o texto do servidor e relê a prévia
 * (a tela mostra o público novo antes de outro envio). Os demais erros ficam no diálogo; o 422 de regra traz o
 * texto do servidor quando o código está em `SERVER_TEXT_CODES`.
 */
function useSubmit({ target, audience, onOpenChange }: FormArgs) {
  const qc = useQueryClient();
  const send = useCreateTeamDispatch();
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<When>('now');

  async function fail(err: unknown) {
    const code = await apiErrorCode(err);
    if (code === AUDIENCE_CHANGED_CODE) {
      toast.error(teamErrorMessage(code));
      void qc.invalidateQueries({ queryKey: AUDIENCE_PREVIEW_KEY });
      onOpenChange(false);
      return;
    }
    setError(await apiErrorText(err, teamErrorMessage));
    if (code && STALE_ROUTE_CODES.has(code)) {
      void qc.invalidateQueries({ queryKey: ['team-whatsapp', target.type === 'user' ? 'person-route' : 'roster'] });
    }
  }

  async function submit(text: string, when: When) {
    setError(null);
    setMode(when);
    try {
      const body: CreateDispatchInput = { text, target: requestTarget(target), ...(audience ? audienceFields(audience) : {}) };
      const result = await send.mutateAsync(when === 'shift_start' ? { ...body, when } : body);
      notifyDone(result, target);
      onOpenChange(false);
    } catch (err) {
      await fail(err);
    }
  }
  return { error, mode, pending: send.isPending, submit };
}

/** Só libera o envio com a prévia do corpo atual, sem nenhuma trava (a do texto inclusive) e com o número aberto. */
function useSendForm(args: FormArgs) {
  const { check, checking, recheck } = useRouteCheck(args.target, args.audience);
  const { error, mode, pending, submit } = useSubmit(args);
  const [text, setText] = useState('');
  const gates = sendGates(check, checking);
  const blocks = args.audience ? sendBlocks(args.audience.preview, text) : [];
  const fresh = args.audience?.isFresh ?? true;
  const ready = text.trim() !== '' && !pending && fresh && blocks.length === 0;
  return {
    check, recheck, text, setText, error, blocks, fresh, pending, mode,
    submit: (when: When) => submit(text, when),
    canSendNow: ready && gates.now, canSchedule: ready && gates.schedule,
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

type FooterProps = { form: ReturnType<typeof useSendForm>; option: ScheduleOption; onClose: () => void };

type ScheduleOption = { show: boolean; blocked: boolean; note: string | null };

const NO_SCHEDULE: ScheduleOption = { show: false, blocked: true, note: null };

/**
 * "No início do turno": só no Aviso de turno (a finalidade que o permite) com um turno de início conhecido; com vários
 * aparece bloqueado, com o motivo (D9). Urgência, Reunião e as demais só têm "Enviar agora".
 */
function scheduleOption(target: SendTarget, purpose: TeamPurpose | undefined): ScheduleOption {
  if (purpose && !PURPOSE_RULES[purpose].when.includes('shift_start')) return NO_SCHEDULE;
  const start = shiftStartOf(target);
  if (start) {
    const passed = hasStarted(start.startsAt);
    return { show: true, blocked: passed, note: passed ? SHIFT_PASSED_TEXT : null };
  }
  const several = target.type === 'sector' && target.shiftIds.length > 1;
  return { show: several, blocked: true, note: several ? ONE_SHIFT_ONLY_TEXT : null };
}

/** Cada trava por extenso, perto do botão (C4); a lista fica velha enquanto a prévia se atualiza. */
function SendBlocks({ form }: { form: ReturnType<typeof useSendForm> }) {
  const { blocks, fresh } = form;
  return (
    <>
      {!fresh && <p className="text-sm text-muted-foreground">Atualizando a lista…</p>}
      {blocks.length > 0 && (
        <ul aria-label="Travas do envio" className="list-disc space-y-0.5 pl-5 text-sm text-destructive">
          {blocks.map((b) => <li key={b.code}>{b.message}</li>)}
        </ul>
      )}
    </>
  );
}

function DialogActions({ form, option, onClose }: FooterProps) {
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

export function SendWhatsappDialog({ open, onOpenChange, target, audience }: Props) {
  const form = useSendForm({ target, audience, onOpenChange });
  const option = scheduleOption(target, audience?.preview.rule.purpose);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Enviar WhatsApp</DialogTitle>
          <DialogDescription>{target.label}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {audience && <AudienceReview preview={audience.preview} />}
          <RoutePreview form={form} />
          <div className="space-y-2">
            <Label htmlFor="team-whatsapp-text">Mensagem</Label>
            <Textarea id="team-whatsapp-text" rows={5} maxLength={MAX_TEXT} value={form.text} onChange={(e) => form.setText(e.target.value)} />
            <p className="text-right text-xs text-muted-foreground">{form.text.length}/{MAX_TEXT}</p>
          </div>
          {form.error && <p role="alert" className="text-sm text-destructive">{form.error}</p>}
          <SendBlocks form={form} />
        </div>
        <DialogActions form={form} option={option} onClose={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}
