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
import { finalTextLength } from '../alert-text';
import { buildChannelGroups, type ChannelGroupsResult } from '../channel-groups';
import { apiErrorCode, apiErrorText, PACING_HINT, SKIP_REASON_LABEL, teamErrorMessage } from '../error-messages';
import { manausDateTime } from '../labels';
import { receivingByArea } from '../member-filter';
import { DRAFT_STALE_TEXT, useMessageDraft, type MessageDraft } from '../message-draft';
import { PURPOSE_RULES } from '../purpose';
import type {
  CreateDispatchInput, DispatchResult, SendTarget, TeamActivity, TeamAudiencePreview, TeamPurpose,
} from '../schemas';
import { momentIncomplete, NOW_MOMENT, type Moment } from '../use-send-filters';
import { AlertConfirmLine, AlertDeadlineNote } from './alert-confirm-line';
import { ChannelGroups, NoSectorNotice, UnverifiedNotice } from './channel-groups';
import { ExcludedGroups } from './excluded-groups';
import { RulePanel } from './rule-panel';
import { SendMoment, type MomentOption } from './send-moment';

const MAX_TEXT = 2000;

/** A prévia que a tela mostra agora (a viva) e se é a do corpo atual (`isFresh`, T14): só então o envio libera. */
export type SendAudience = { preview: TeamAudiencePreview; isFresh: boolean };

type SectorTarget = Extract<SendTarget, { type: 'sector' }>;
type UserTarget = Extract<SendTarget, { type: 'user' }>;

/** O momento do disparo que a tela guarda nos filtros (DG11) e o "hoje" do servidor, para o limite da data. */
export type MomentControl = { value: Moment; onChange: (moment: Moment) => void; today: string };

/** Alvo pessoa não tem momento: só "agora". */
const NO_MOMENT: MomentControl = { value: NOW_MOMENT, onChange: () => undefined, today: '' };

/** Alvo setor: o texto mora na página (DG12), por isso fechar o diálogo não o perde. Alvo pessoa guarda o próprio. */
type Props = { open: boolean; onOpenChange: (open: boolean) => void } & (
  | { target: UserTarget; audience?: undefined; moment?: undefined; draft?: undefined }
  | { target: SectorTarget; audience: SendAudience; moment: MomentControl; draft: MessageDraft }
);

type FormArgs = {
  target: SendTarget;
  audience: SendAudience | undefined;
  moment: MomentControl;
  draft: MessageDraft;
  onOpenChange: (open: boolean) => void;
};

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
      {rule.purpose === 'urgency' && <AlertDeadlineNote />}
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
const MOMENT_INCOMPLETE: Block = { code: 'moment_incomplete', message: 'Informe a data e a hora do envio.' };
const DRAFT_STALE: Block = { code: 'draft_stale', message: DRAFT_STALE_TEXT };
const TEXT_TOO_LONG: Block = { code: 'text_too_long', message: `A mensagem passa de ${MAX_TEXT} caracteres.` };

/**
 * Travas perto do botão, na ordem do servidor (CF4). A prévia vai com `text: ''` (DF11): a trava do texto sai da
 * lista dela e é conferida aqui, com o mesmo texto e na mesma posição (a primeira). Também só aqui: o texto preenchido
 * com dados que mudaram (G2) e o texto que passou do limite (o cabeçalho conta e, na Urgência, a linha fixa também);
 * "Data e hora" sem data ou sem hora também trava aqui: a prévia ainda é a de agora e nada a diria.
 */
function sendBlocks(preview: TeamAudiencePreview, draft: Pick<MessageDraft, 'text' | 'stale'>, moment: Moment): Block[] {
  const { text, stale } = draft;
  const fromServer = preview.blocks.filter((b) => b.code !== EMPTY_TEXT_CODE);
  const emptyText: Block[] = text.trim() === '' ? [{ code: EMPTY_TEXT_CODE, message: teamErrorMessage(EMPTY_TEXT_CODE) }] : [];
  return [
    ...emptyText,
    ...(stale ? [DRAFT_STALE] : []),
    ...(finalTextLength(text, preview.rule.purpose) > MAX_TEXT ? [TEXT_TOO_LONG] : []),
    ...(momentIncomplete(moment) ? [MOMENT_INCOMPLETE] : []),
    ...fromServer,
  ];
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

type When = Moment['when'];

const SHIFT_PASSED_TEXT = 'O início deste turno já passou';
const ONE_SHIFT_ONLY_TEXT = 'No início do turno só vale com um turno escolhido';

/** "No início do turno" só vale com exatamente um turno (D9); o início vem do servidor (GC5). */
function shiftStartOf(target: SendTarget): NonNullable<SectorTarget['shiftStart']> | null {
  return target.type === 'sector' && target.shiftIds.length === 1 ? (target.shiftStart ?? null) : null;
}

const hasStarted = (startsAt: string) => Date.parse(startsAt) <= Date.now();

/**
 * Aviso de agendado (herdado 5): a data e a hora que a prévia confirmada trouxe (`rule.scheduledFor`, Manaus). Prévia
 * sem `scheduledFor` (servidor que ainda não o devolve): vale o início do turno do alvo.
 */
function scheduledTitle(result: DispatchResult, target: SendTarget, scheduledFor: string | null | undefined): string | null {
  if (result.scheduled <= 0) return null;
  if (scheduledFor) {
    const { date, time } = manausDateTime(scheduledFor);
    return `Agendado para ${date} às ${time}.`;
  }
  return target.type === 'sector' && target.shiftStart
    ? `Agendado para ${formatDayMonth(target.date)} às ${target.shiftStart.startTime}`
    : null;
}

function notifyDone(result: DispatchResult, target: SendTarget, scheduledFor: string | null | undefined) {
  const skipped = result.skipped.map((s) => `${s.name}: ${SKIP_REASON_LABEL[s.reason]}`);
  const scheduled = scheduledTitle(result, target, scheduledFor);
  toast.success(scheduled ?? `Mensagem enfileirada para ${result.queued} pessoa(s)`, {
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
 * O corpo só leva `when` fora do "agora"; "Data e hora" leva também a data e a hora digitadas. Sem as duas, `null`:
 * nunca cai para o corpo de "agora" (envio imediato); a trava de momento incompleto já segura o botão.
 */
function whenFields(when: When, moment: Moment): Pick<CreateDispatchInput, 'when' | 'at'> | null {
  if (when === 'at') return moment.at && !momentIncomplete({ when, at: moment.at }) ? { when, at: moment.at } : null;
  return when === 'shift_start' ? { when } : {};
}

/**
 * Envio e recusas. 409 `audience_changed`: fecha a confirmação, avisa com o texto do servidor e relê a prévia
 * (a tela mostra o público novo antes de outro envio). Os demais erros ficam no diálogo; o 422 de regra traz o
 * texto do servidor quando o código está em `SERVER_TEXT_CODES`.
 */
function useSubmit({ target, audience, moment, draft, onOpenChange }: FormArgs) {
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
    const timing = whenFields(when, moment.value);
    if (!timing) return;
    setError(null);
    setMode(when);
    try {
      const body: CreateDispatchInput = {
        text, target: requestTarget(target), ...(audience ? audienceFields(audience) : {}), ...timing,
      };
      const result = await send.mutateAsync(body);
      notifyDone(result, target, audience?.preview.rule.scheduledFor);
      draft.reset();
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
  const { draft } = args;
  const { text } = draft;
  const gates = sendGates(check, checking);
  const blocks = args.audience ? sendBlocks(args.audience.preview, draft, args.moment.value) : [];
  const fresh = args.audience?.isFresh ?? true;
  const ready = text.trim() !== '' && !pending && fresh && blocks.length === 0;
  return {
    check, recheck, text, setText: draft.setText, draft, error, blocks, fresh, pending, mode, moment: args.moment.value,
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
 * aparece bloqueado, com o motivo (D9). As demais finalidades não o oferecem.
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

type ScheduleButtonProps = { form: ReturnType<typeof useSendForm>; blocked: boolean; when: 'shift_start' | 'at'; label: string };

/** Botão que agenda: só `canSchedule` (o número aberto não é exigido, D7) e, no início do turno, o turno ainda por vir. */
function ScheduleButton({ form, blocked, when, label }: ScheduleButtonProps) {
  return (
    <Button disabled={!form.canSchedule || blocked} onClick={() => form.submit(when)}>
      {form.pending && form.mode === when ? 'Agendando...' : label}
    </Button>
  );
}

/**
 * Um botão só, o do momento escolhido: em "Agora", "Enviar agora"; agendar só pelo controle do momento, para que a
 * prévia (painel, travas, `audienceKey`) já traga o momento. O que o operador confere no painel é o que o botão envia.
 */
function DialogActions({ form, option, onClose }: FooterProps) {
  const { when } = form.moment;
  return (
    <>
      {option.note && <p className="w-full text-sm text-muted-foreground">{option.note}</p>}
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>Cancelar</Button>
        {when === 'shift_start' && (
          <ScheduleButton form={form} blocked={option.blocked} when="shift_start" label="No início do turno" />
        )}
        {when === 'at' && <ScheduleButton form={form} blocked={false} when="at" label="Agendar" />}
        {when === 'now' && (
          <Button disabled={!form.canSendNow} onClick={() => form.submit('now')}>
            {form.pending && form.mode === 'now' ? 'Enviando...' : 'Enviar agora'}
          </Button>
        )}
      </DialogFooter>
    </>
  );
}

const FILL_TEXT = 'Preencher com os dados da atividade';

/**
 * G2: o botão do preenchimento só existe na finalidade que tem atividade, e só habilita com data e hora. Com o texto
 * velho ele vira "Preencher de novo" e aparece "Conferi o texto"; este fica mesmo sem o botão (a finalidade pode ter
 * mudado depois do preenchimento), senão a trava do texto velho não teria como sair.
 */
function DraftControls({ draft, purpose }: { draft: MessageDraft; purpose: TeamPurpose | undefined }) {
  const fills = purpose !== undefined && PURPOSE_RULES[purpose].activity !== 'none';
  if (!fills && !draft.stale) return null;
  return (
    <div className="flex flex-wrap items-center gap-3">
      {fills && (
        <Button variant="outline" size="sm" disabled={!draft.canFill} onClick={draft.fill}>
          {draft.stale ? 'Preencher de novo' : FILL_TEXT}
        </Button>
      )}
      {draft.stale && (
        <Button type="button" variant="outline" size="sm" onClick={draft.confirmChecked}>Conferi o texto</Button>
      )}
    </div>
  );
}

/** "Agora" sempre; "No início do turno" e "Data e hora" só no alvo setor, pelo que a finalidade permite (GG2). */
function momentOptions(target: SendTarget, purpose: TeamPurpose | undefined, shiftStart: ScheduleOption): MomentOption[] {
  const allowed: readonly When[] = target.type === 'sector' && purpose ? PURPOSE_RULES[purpose].when : ['now'];
  return [
    { when: 'now' },
    ...(shiftStart.show ? [{ when: 'shift_start' as const, disabled: shiftStart.blocked }] : []),
    ...(allowed.includes('at') ? [{ when: 'at' as const }] : []),
  ];
}

export function SendWhatsappDialog({ open, onOpenChange, target, audience, moment = NO_MOMENT, draft }: Props) {
  const own = useMessageDraft('shift_notice', null);
  const form = useSendForm({ target, audience, moment, draft: draft ?? own, onOpenChange });
  const purpose = audience?.preview.rule.purpose;
  const option = scheduleOption(target, purpose);
  const options = momentOptions(target, purpose, option);
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
            <DraftControls draft={form.draft} purpose={purpose} />
            <Textarea id="team-whatsapp-text" rows={5} maxLength={MAX_TEXT} value={form.text} onChange={(e) => form.setText(e.target.value)} />
            {purpose === 'urgency' && <AlertConfirmLine />}
            <p className="text-right text-xs text-muted-foreground">{finalTextLength(form.text, purpose)}/{MAX_TEXT}</p>
          </div>
          {options.length > 1 && (
            <SendMoment value={moment.value} onChange={moment.onChange} options={options} today={moment.today} />
          )}
          {form.error && <p role="alert" className="text-sm text-destructive">{form.error}</p>}
          <SendBlocks form={form} />
        </div>
        <DialogActions form={form} option={option} onClose={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}
