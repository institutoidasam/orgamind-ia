import { useState } from 'react';
import { PURPOSE_RULES } from './purpose';
import type {
  SectorTargetInput, TeamActivityInput, TeamAudienceBase, TeamAudienceRequest, TeamPurpose, TeamSector,
} from './schemas';
import type { SendInitial } from './send-search';

/** Dados da atividade como o operador os digita: '' = não informado. */
export type ActivityDraft = { date: string; time: string; place: string };

/**
 * Momento do disparo (G1, DG11). 'at' = data e hora livres no fuso de Manaus, como o operador as digita ('' = falta);
 * `at` só existe com 'at'. Vai na prévia, para o painel, as travas e o aviso serem os do momento escolhido.
 */
export type Moment = {
  when: 'now' | 'shift_start' | 'at';
  at: { date: string; time: string } | null;
};

export const NOW_MOMENT: Moment = { when: 'now', at: null };

/** "Data e hora" sem a data ou sem a hora: a prévia ainda é a de agora e o envio fica travado (GG2). */
export function momentIncomplete({ when, at }: Moment): boolean {
  return when === 'at' && !(at?.date && at.time);
}

type Filters = {
  /** null = ainda não mexeu: vazio, ou o único setor possível (já escolhido). */
  sectorIds: string[] | null;
  levelIds: string[];
  withoutLevel: boolean;
  /** null = ainda não escolheu; [] = "Todos os turnos". */
  shiftIds: string[] | null;
  /** Data da tela: a de referência no Aviso de turno e na Urgência (GF4). */
  date: string;
  purpose: TeamPurpose;
  base: TeamAudienceBase;
  includeOff: boolean;
  activity: ActivityDraft;
  urgencyReason: string;
  moment: Moment;
};

const NO_ACTIVITY: ActivityDraft = { date: '', time: '', place: '' };

/** "Incluir quem está de folga" só existe na base vinculada e nas finalidades que têm a opção (C1). */
export function offAvailable(purpose: TeamPurpose, base: TeamAudienceBase): boolean {
  return PURPOSE_RULES[purpose].offOption !== 'none' && base === 'assigned';
}

/** Estado inicial da folga: marcada em Reunião e Palestra, desmarcada nas outras (C1). */
function defaultOff(purpose: TeamPurpose, base: TeamAudienceBase): boolean {
  return offAvailable(purpose, base) && PURPOSE_RULES[purpose].offOption === 'checked';
}

/** Trocar a finalidade volta à base padrão dela, ao estado inicial da folga e ao momento "Agora" (DG11). */
function withPurpose(prev: Filters, purpose: TeamPurpose): Filters {
  const base = PURPOSE_RULES[purpose].bases[0];
  return { ...prev, purpose, base, includeOff: defaultOff(purpose, base), moment: NOW_MOMENT };
}

/** Só o Alinhamento tem mais de uma base; outra base da finalidade é ignorada. */
function withBase(prev: Filters, base: TeamAudienceBase): Filters {
  if (!PURPOSE_RULES[prev.purpose].bases.includes(base)) return prev;
  return { ...prev, base, includeOff: defaultOff(prev.purpose, base) };
}

/**
 * Filtros da tela de envio (finalidade, setores, níveis, data, turnos, atividade, "incluir quem está de folga")
 * e a seleção. Mudança que altera quem entra no público limpa a seleção: o que vai no POST é a lista conferida
 * (D4). A data inicial é `today` do servidor (GC5), nunca o relógio do navegador; `initial` (setores e data da URL,
 * só no estado inicial) a substitui quando vem preenchido.
 */
export function useSendFilters(today: string, sectors: readonly TeamSector[], initial?: SendInitial) {
  const [filters, setFilters] = useState<Filters>({
    sectorIds: initial?.sectorIds ?? null, levelIds: [], withoutLevel: false, shiftIds: null, date: initial?.date ?? today,
    purpose: 'shift_notice', base: PURPOSE_RULES.shift_notice.bases[0], includeOff: false,
    activity: NO_ACTIVITY, urgencyReason: '', moment: NOW_MOMENT,
  });
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const change = (next: (prev: Filters) => Filters) => {
    setFilters(next);
    setSelected(new Set());
  };
  const update = (patch: Partial<Filters>) => change((prev) => ({ ...prev, ...patch }));
  return {
    ...filters,
    sectorIds: filters.sectorIds ?? (sectors.length === 1 ? [sectors[0].id] : []),
    shiftIds: filters.shiftIds ?? [],
    shiftsPicked: filters.shiftIds !== null,
    selected,
    setSelected,
    pickSectors: (sectorIds: string[]) => update({ sectorIds }),
    pickLevels: (levelIds: string[], withoutLevel: boolean) => update({ levelIds, withoutLevel }),
    pickDate: (date: string) => update({ date }),
    pickShifts: (shiftIds: string[] | null) => update({ shiftIds }),
    pickPurpose: (purpose: TeamPurpose) => change((prev) => withPurpose(prev, purpose)),
    pickBase: (base: TeamAudienceBase) => change((prev) => withBase(prev, base)),
    toggleOff: (includeOff: boolean) => update({ includeOff: includeOff && offAvailable(filters.purpose, filters.base) }),
    /** A data da atividade pode ser a de referência (muda o público); hora e local não. */
    pickActivity: (patch: Partial<ActivityDraft>) => {
      const merge = (prev: Filters): Filters => ({ ...prev, activity: { ...prev.activity, ...patch } });
      if (patch.date === undefined) setFilters(merge);
      else change(merge);
    },
    pickUrgencyReason: (urgencyReason: string) => setFilters((prev) => ({ ...prev, urgencyReason })),
    /** O momento não muda quem recebe nem a impressão da prévia: a seleção fica (o diálogo aberto a leva). */
    setMoment: (moment: Moment) => setFilters((prev) => ({ ...prev, moment })),
    viewShift: (date: string, shiftId: string) => update({ date, shiftIds: [shiftId] }),
    toggle: (id: string) =>
      setSelected((prev) => {
        const next = new Set(prev);
        if (!next.delete(id)) next.add(id);
        return next;
      }),
  };
}

export type SendFilters = ReturnType<typeof useSendFilters>;

type DateFilters = Pick<SendFilters, 'purpose' | 'date' | 'activity'>;

/** Finalidade sem atividade (Aviso de turno, Urgência): a data é a da tela, com o atalho do turno em andamento. */
export function usesScreenDate(purpose: TeamPurpose): boolean {
  return PURPOSE_RULES[purpose].activity === 'none';
}

/**
 * O campo "Data" da tela é a data de referência quando não há atividade (Aviso de turno, Urgência) e no
 * Alinhamento sem a data da atividade; com a atividade obrigatória ou a data dela informada, vale a da atividade.
 */
export function showsScreenDate({ purpose, activity }: Pick<DateFilters, 'purpose' | 'activity'>): boolean {
  const kind = PURPOSE_RULES[purpose].activity;
  return kind === 'none' || (kind === 'optional' && activity.date === '');
}

/**
 * Data de referência (GF4): a da atividade em Reunião, Palestra e Hora extra; no Alinhamento, a da atividade se
 * informada, senão a da tela; Aviso de turno e Urgência, a da tela. '' = falta a data da atividade.
 */
export function referenceDate(filters: DateFilters): string {
  return showsScreenDate(filters) ? filters.date : filters.activity.date;
}

type RequestFilters = DateFilters & Pick<
  SendFilters,
  'sectorIds' | 'levelIds' | 'withoutLevel' | 'shiftIds' | 'shiftsPicked' | 'base' | 'includeOff' | 'urgencyReason'
> & { moment?: Moment };

/** Só o que o operador informou, aparado; nenhum campo = sem atividade. Finalidade sem atividade não a leva. */
function activityBody({ purpose, activity }: Pick<RequestFilters, 'purpose' | 'activity'>): TeamActivityInput | undefined {
  if (PURPOSE_RULES[purpose].activity === 'none') return undefined;
  const place = activity.place.trim();
  const body: TeamActivityInput = {
    ...(activity.date ? { date: activity.date } : {}),
    ...(activity.time ? { time: activity.time } : {}),
    ...(place ? { place } : {}),
  };
  return Object.keys(body).length > 0 ? body : undefined;
}

function targetBody(filters: RequestFilters, date: string): SectorTargetInput {
  const { sectorIds, shiftIds, levelIds } = filters;
  return {
    type: 'sector',
    sectorIds,
    date,
    ...(shiftIds.length > 0 ? { shiftIds } : {}),
    ...(levelIds.length > 0 ? { levelIds } : {}),
    ...(filters.withoutLevel ? { withoutLevel: true } : {}),
    ...(offAvailable(filters.purpose, filters.base) ? { includeOff: filters.includeOff } : {}),
  };
}

/** `when` e `at` da prévia: "Agora" não os leva; "Data e hora" só quando a data e a hora estão preenchidas. */
function momentBody(moment: Moment | undefined): Pick<TeamAudienceRequest, 'when' | 'at'> {
  if (!moment || moment.when === 'now') return {};
  if (moment.when === 'shift_start') return { when: 'shift_start' };
  const { date, time } = moment.at ?? { date: '', time: '' };
  return date && time ? { when: 'at', at: { date, time } } : {};
}

/**
 * Corpo da prévia (CF2) montado dos filtros, sem texto (a prévia aceita vazio), com o momento (DG11). `null`
 * = ainda não dá para pedir: falta setor, turno ou a data de referência. A seleção nominal (`userIds`) é de quem
 * confere ou envia. Folga só vai onde a opção existe (na base em serviço o servidor recusa).
 */
export function audienceRequest(filters: RequestFilters): TeamAudienceRequest | null {
  const { purpose, base } = filters;
  const date = referenceDate(filters);
  if (filters.sectorIds.length === 0 || !filters.shiftsPicked || date === '') return null;
  const reason = filters.urgencyReason.trim();
  const activity = activityBody(filters);
  return {
    text: '',
    purpose,
    base,
    target: targetBody(filters, date),
    ...momentBody(filters.moment),
    ...(activity ? { activity } : {}),
    ...(PURPOSE_RULES[purpose].urgencyReason && reason ? { urgencyReason: reason } : {}),
  };
}
