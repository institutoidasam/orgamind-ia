import type { TeamPurpose } from '../../schemas/contracts/team-whatsapp.schema';
import { zonedStart, type CivilDate } from '../staff-schedule/civil-date';
import type { AudienceBase } from './audience-classify';
import type { TeamAudienceRequest } from './dto/create-team-dispatch.dto';
import {
  MISSING_ACTIVITY_DATE_TIME_TEXT,
  audienceBlock,
  invalidBase,
  invalidOffOption,
  invalidReferenceDate,
  whenNotAllowed,
  type AudienceBlock,
} from './team-whatsapp.errors';

export type Purpose = TeamPurpose;

/**
 * Regra de uma finalidade (C1/GF2). O front copia esta matriz em
 * `frontend/src/features/team-whatsapp/purpose.ts`: mexeu aqui, mexa lá.
 */
export type PurposeRule = {
  /** `[0]` é a base padrão; com mais de uma, o operador escolhe (Alinhamento). */
  bases: readonly AudienceBase[];
  /** `none` = sem opção de folga; `checked`/`unchecked` = estado inicial na tela. */
  offOption: 'none' | 'checked' | 'unchecked';
  /** `required` = data, hora e local; `optional` = se informada, data e hora (local opcional). */
  activity: 'none' | 'required' | 'optional';
  urgencyReason: boolean;
  /** Hora extra: pelo menos uma pessoa marcada. */
  selectionRequired: boolean;
  /** Momentos de disparo permitidos. */
  when: readonly ('now' | 'shift_start')[];
};

export const PURPOSE_RULES: Record<Purpose, PurposeRule> = {
  shift_notice: {
    bases: ['on_duty'],
    offOption: 'none',
    activity: 'none',
    urgencyReason: false,
    selectionRequired: false,
    when: ['now', 'shift_start'],
  },
  meeting: {
    bases: ['assigned'],
    offOption: 'checked',
    activity: 'required',
    urgencyReason: false,
    selectionRequired: false,
    when: ['now'],
  },
  alignment: {
    bases: ['assigned', 'on_duty'],
    offOption: 'unchecked',
    activity: 'optional',
    urgencyReason: false,
    selectionRequired: false,
    when: ['now'],
  },
  lecture: {
    bases: ['assigned'],
    offOption: 'checked',
    activity: 'required',
    urgencyReason: false,
    selectionRequired: false,
    when: ['now'],
  },
  overtime: {
    bases: ['assigned'],
    offOption: 'unchecked',
    activity: 'required',
    urgencyReason: false,
    selectionRequired: true,
    when: ['now'],
  },
  urgency: {
    bases: ['on_duty'],
    offOption: 'none',
    activity: 'none',
    urgencyReason: true,
    selectionRequired: false,
    when: ['now'],
  },
};

/** Base do público: a pedida, se a finalidade a admite; ausente = a padrão. 422 `invalid_base`. */
export function resolveBase(
  purpose: Purpose,
  base: AudienceBase | undefined,
): AudienceBase {
  const { bases } = PURPOSE_RULES[purpose];
  if (base === undefined) return bases[0];
  if (!bases.includes(base)) throw invalidBase();
  return base;
}

/** O que `assertPurposeRules` lê do pedido (prévia e envio de setor). */
export type AudienceRuleInput = Pick<
  TeamAudienceRequest,
  'purpose' | 'base' | 'when' | 'activity'
> & {
  target: Pick<TeamAudienceRequest['target'], 'date' | 'includeOff'>;
};

/**
 * Erros de regra (DF8, 422 na prévia e no envio), antes de qualquer alcance:
 * base fora da fixada, folga na base em serviço, momento não permitido e data
 * de referência diferente da data da atividade (GF4). A atividade só vale nas
 * finalidades que a têm; sem data da atividade não há o que conferir.
 */
export function assertPurposeRules(input: AudienceRuleInput): void {
  const rule = PURPOSE_RULES[input.purpose];
  const base = resolveBase(input.purpose, input.base);
  if (input.target.includeOff === true && base === 'on_duty')
    throw invalidOffOption();
  if (!rule.when.includes(input.when ?? 'now')) throw whenNotAllowed();
  const activityDate =
    rule.activity === 'none' ? undefined : input.activity?.date;
  if (activityDate !== undefined && activityDate !== input.target.date)
    throw invalidReferenceDate();
}

/** Atividade com data e hora (a trava `after_activity_start` só confere assim). */
export type CompleteActivity = { date: CivilDate; time: string };

/** Instante em que a atividade começa (relógio de Manaus). */
export function activityStart(activity: CompleteActivity): Date {
  return zonedStart(activity.date, activity.time);
}

export type BlocksInput = {
  request: Pick<
    TeamAudienceRequest,
    'purpose' | 'text' | 'when' | 'activity' | 'urgencyReason'
  >;
  /** Quantos vão receber (público vazio = `no_recipients`). */
  receivingCount: number;
  /** Tamanho da seleção nominal; null = sem seleção. */
  selectedCount: number | null;
  /** Início do turno em que o envio sairia; null = agora. */
  scheduledFor: Date | null;
  numbersMissing: boolean;
  now: Date;
};

type Check = (input: BlocksInput) => AudienceBlock | null;

/** Texto que o DTO apara chega como `''`: vazio vale como ausente. */
function filled(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== '';
}

const emptyText: Check = ({ request }) =>
  filled(request.text) ? null : audienceBlock('empty_text');

type ActivityInput = NonNullable<BlocksInput['request']['activity']>;

/** Data, hora e local, todos preenchidos (Reunião, Palestra e Hora extra). */
const requiredActivityBlock = (a: ActivityInput): AudienceBlock | null =>
  filled(a.date) && filled(a.time) && filled(a.place)
    ? null
    : audienceBlock('missing_activity');

/** Alinhamento: sem nada informado não trava; informada, data e hora (local opcional). */
const optionalActivityBlock = (a: ActivityInput): AudienceBlock | null => {
  const informed = filled(a.date) || filled(a.time) || filled(a.place);
  if (!informed || (filled(a.date) && filled(a.time))) return null;
  return audienceBlock('missing_activity', MISSING_ACTIVITY_DATE_TIME_TEXT);
};

const missingActivity: Check = ({ request }) => {
  const mode = PURPOSE_RULES[request.purpose].activity;
  const activity = request.activity ?? {};
  if (mode === 'required') return requiredActivityBlock(activity);
  return mode === 'optional' ? optionalActivityBlock(activity) : null;
};

const missingUrgencyReason: Check = ({ request }) =>
  PURPOSE_RULES[request.purpose].urgencyReason && !filled(request.urgencyReason)
    ? audienceBlock('missing_urgency_reason')
    : null;

const overtimeWithoutSelection: Check = ({ request, selectedCount }) =>
  PURPOSE_RULES[request.purpose].selectionRequired && (selectedCount ?? 0) === 0
    ? audienceBlock('overtime_without_selection')
    : null;

const scheduleInPast: Check = ({ scheduledFor, now }) =>
  scheduledFor !== null && scheduledFor.getTime() <= now.getTime()
    ? audienceBlock('schedule_in_past')
    : null;

/** GF10: vale no "agora" e no início do turno; sair no instante do início também trava. */
const afterActivityStart: Check = ({ request, scheduledFor, now }) => {
  const { date, time } = request.activity ?? {};
  if (PURPOSE_RULES[request.purpose].activity === 'none') return null;
  if (!filled(date) || !filled(time)) return null;
  const departure = (scheduledFor ?? now).getTime();
  return departure >= activityStart({ date, time }).getTime()
    ? audienceBlock('after_activity_start')
    : null;
};

const noRecipients: Check = ({ receivingCount }) =>
  receivingCount === 0 ? audienceBlock('no_recipients') : null;

const sectorWithoutNumber: Check = ({ numbersMissing }) =>
  numbersMissing ? audienceBlock('sector_without_number') : null;

// Ordem fixa do CF4: o envio responde 422 com a primeira.
const CHECKS: readonly Check[] = [
  emptyText,
  missingActivity,
  missingUrgencyReason,
  overtimeWithoutSelection,
  scheduleInPast,
  afterActivityStart,
  noRecipients,
  sectorWithoutNumber,
];

/** Travas do botão, na ordem do CF4 (puro, sem banco): prévia devolve a lista; envio, a primeira. */
export function blocksFor(input: BlocksInput): AudienceBlock[] {
  return CHECKS.flatMap((check) => check(input) ?? []);
}
