import { describe, expect, it } from 'vitest';
import type { DomainError } from '../../shared/errors/domain.error';
import type { TeamPurpose } from '../../schemas/contracts/team-whatsapp.schema';
import type { TeamAudienceRequest } from './dto/create-team-dispatch.dto';
import {
  MISSING_ACTIVITY_DATE_TIME_TEXT,
  type AudienceBlock,
} from './team-whatsapp.errors';
import {
  PURPOSE_RULES,
  activityStart,
  assertPurposeRules,
  blocksFor,
  resolveBase,
  type BlocksInput,
} from './team-whatsapp.purpose';

const DATE = '2026-11-21';
// 06:00 em Manaus; a atividade de 09:00 começa às 13:00Z.
const NOW = new Date('2026-11-21T10:00:00Z');
const FULL_ACTIVITY = { date: DATE, time: '09:00', place: 'Auditório' };

const MATRIX: typeof PURPOSE_RULES = {
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

const request = (
  purpose: TeamPurpose,
  over: Partial<TeamAudienceRequest> = {},
  target: Partial<TeamAudienceRequest['target']> = {},
): TeamAudienceRequest => ({
  text: 'Aviso para a equipe',
  purpose,
  target: { type: 'sector', sectorIds: ['s1'], date: DATE, ...target },
  ...over,
});

const blocksOf = (r: TeamAudienceRequest, over: Partial<BlocksInput> = {}) =>
  blocksFor({
    request: r,
    receivingCount: 2,
    selectedCount: null,
    scheduledFor: null,
    numbersMissing: false,
    now: NOW,
    ...over,
  });

const codes = (blocks: AudienceBlock[]) =>
  blocks.map((b) => b.code.replace('team_whatsapp.', ''));

/** Erro de regra lançado (código, status e texto), ou null se nada foi lançado. */
function thrown(fn: () => unknown) {
  try {
    fn();
  } catch (e) {
    const { code, status, message } = e as DomainError;
    return { code, status, message };
  }
  return null;
}

const rule422 = (code: string, message: string) => ({
  code: `team_whatsapp.${code}`,
  status: 422,
  message,
});

describe('matriz da finalidade e base (CF5)', () => {
  it('PURPOSE_RULES segue a matriz do C1', () => {
    expect(PURPOSE_RULES).toEqual(MATRIX);
  });

  it('aceite 10: base diferente da fixada 422 invalid_base; Alinhamento aceita as duas; ausente = padrão', () => {
    expect(resolveBase('meeting', undefined)).toBe('assigned');
    expect(resolveBase('urgency', undefined)).toBe('on_duty');
    expect(resolveBase('alignment', undefined)).toBe('assigned');
    expect(resolveBase('alignment', 'on_duty')).toBe('on_duty');
    expect(resolveBase('alignment', 'assigned')).toBe('assigned');
    expect(resolveBase('lecture', 'assigned')).toBe('assigned');
    const invalid = rule422(
      'invalid_base',
      'A base do público desta finalidade é fixa.',
    );
    expect(thrown(() => resolveBase('meeting', 'on_duty'))).toEqual(invalid);
    expect(thrown(() => resolveBase('shift_notice', 'assigned'))).toEqual(
      invalid,
    );
    const viaRules = request('overtime', { base: 'on_duty' });
    expect(thrown(() => assertPurposeRules(viaRules))).toEqual(invalid);
  });
});

describe('assertPurposeRules: folga e momento (DF8)', () => {
  it('includeOff na base em serviço 422 invalid_off_option', () => {
    const off = { includeOff: true };
    const invalid = rule422(
      'invalid_off_option',
      'A equipe em serviço não tem a opção de incluir quem está de folga.',
    );
    const urgency = request('urgency', {}, off);
    expect(thrown(() => assertPurposeRules(urgency))).toEqual(invalid);
    const onDuty = request('alignment', { base: 'on_duty' }, off);
    expect(thrown(() => assertPurposeRules(onDuty))).toEqual(invalid);
    const assigned = request('alignment', { base: 'assigned' }, off);
    expect(thrown(() => assertPurposeRules(assigned))).toBeNull();
    const noOff = request(
      'alignment',
      { base: 'on_duty' },
      { includeOff: false },
    );
    expect(thrown(() => assertPurposeRules(noOff))).toBeNull();
  });

  it('shift_start fora do Aviso de turno 422 when_not_allowed', () => {
    const invalid = rule422(
      'when_not_allowed',
      'Esta finalidade não pode ser enviada nesse momento.',
    );
    const meeting = request('meeting', { when: 'shift_start' });
    expect(thrown(() => assertPurposeRules(meeting))).toEqual(invalid);
    const urgency = request('urgency', { when: 'shift_start' });
    expect(thrown(() => assertPurposeRules(urgency))).toEqual(invalid);
    const notice = request('shift_notice', { when: 'shift_start' });
    expect(thrown(() => assertPurposeRules(notice))).toBeNull();
    expect(thrown(() => assertPurposeRules(request('meeting')))).toBeNull();
  });
});

describe('assertPurposeRules: data de referência', () => {
  it('data de referência diferente da data da atividade 422; sem data da atividade não confere', () => {
    const invalid = rule422(
      'invalid_reference_date',
      'A data de referência precisa ser a data da atividade.',
    );
    const other = { ...FULL_ACTIVITY, date: '2026-11-22' };
    const meeting = request('meeting', { activity: other });
    expect(thrown(() => assertPurposeRules(meeting))).toEqual(invalid);
    const alignment = request('alignment', { activity: other });
    expect(thrown(() => assertPurposeRules(alignment))).toEqual(invalid);
    const same = request('meeting', { activity: FULL_ACTIVITY });
    expect(thrown(() => assertPurposeRules(same))).toBeNull();
    const noDate = request('meeting', { activity: { time: '09:00' } });
    expect(thrown(() => assertPurposeRules(noDate))).toBeNull();
    const ignored = request('shift_notice', { activity: other });
    expect(thrown(() => assertPurposeRules(ignored))).toBeNull();
  });
});

describe('blocksFor: dados da atividade', () => {
  it('aceite 4: palestra sem hora ou sem local trava missing_activity com o texto', () => {
    const block = {
      code: 'team_whatsapp.missing_activity',
      message: 'Informe a data, a hora e o local da atividade.',
    };
    const noTime = { date: DATE, place: 'Auditório' };
    expect(blocksOf(request('lecture', { activity: noTime }))).toEqual([block]);
    const noPlace = { date: DATE, time: '09:00' };
    expect(blocksOf(request('lecture', { activity: noPlace }))).toEqual([
      block,
    ]);
    const blankPlace = { ...FULL_ACTIVITY, place: '' };
    expect(blocksOf(request('lecture', { activity: blankPlace }))).toEqual([
      block,
    ]);
    expect(blocksOf(request('lecture'))).toEqual([block]);
    expect(blocksOf(request('lecture', { activity: FULL_ACTIVITY }))).toEqual(
      [],
    );
  });

  it('Alinhamento: sem atividade não trava; com data sem hora trava com Informe a data e a hora da atividade.', () => {
    const block = {
      code: 'team_whatsapp.missing_activity',
      message: 'Informe a data e a hora da atividade.',
    };
    expect(MISSING_ACTIVITY_DATE_TIME_TEXT).toBe(block.message);
    expect(blocksOf(request('alignment'))).toEqual([]);
    const noTime = request('alignment', { activity: { date: DATE } });
    expect(blocksOf(noTime)).toEqual([block]);
    const onlyPlace = request('alignment', { activity: { place: 'Sala' } });
    expect(blocksOf(onlyPlace)).toEqual([block]);
    const noPlace = { activity: { date: DATE, time: '09:00' } };
    expect(blocksOf(request('alignment', noPlace))).toEqual([]);
  });
});

describe('blocksFor: urgência e hora extra', () => {
  it('aceite 8: urgência exige motivo, só agora, base em serviço', () => {
    const block = {
      code: 'team_whatsapp.missing_urgency_reason',
      message: 'Informe o motivo da urgência.',
    };
    expect(blocksOf(request('urgency'))).toEqual([block]);
    expect(blocksOf(request('urgency', { urgencyReason: '' }))).toEqual([
      block,
    ]);
    const reason = { urgencyReason: 'Falta de energia' };
    expect(blocksOf(request('urgency', reason))).toEqual([]);
    expect(blocksOf(request('meeting', { activity: FULL_ACTIVITY }))).toEqual(
      [],
    );
    const later = request('urgency', { when: 'shift_start' });
    expect(thrown(() => assertPurposeRules(later))?.code).toBe(
      'team_whatsapp.when_not_allowed',
    );
    expect(thrown(() => resolveBase('urgency', 'assigned'))?.code).toBe(
      'team_whatsapp.invalid_base',
    );
  });

  it('overtime_without_selection com seleção vazia ou ausente', () => {
    const block = {
      code: 'team_whatsapp.overtime_without_selection',
      message: 'Marque pelo menos uma pessoa para a hora extra.',
    };
    const overtime = request('overtime', { activity: FULL_ACTIVITY });
    expect(blocksOf(overtime, { selectedCount: null })).toEqual([block]);
    expect(blocksOf(overtime, { selectedCount: 0 })).toEqual([block]);
    expect(blocksOf(overtime, { selectedCount: 1 })).toEqual([]);
    const meeting = request('meeting', { activity: FULL_ACTIVITY });
    expect(blocksOf(meeting, { selectedCount: 0 })).toEqual([]);
  });
});

describe('blocksFor: início da atividade', () => {
  it('after_activity_start no agora e no início do turno; igual ao início também trava', () => {
    const block = {
      code: 'team_whatsapp.after_activity_start',
      message: 'A mensagem precisa sair antes do início da atividade.',
    };
    const meeting = request('meeting', { activity: FULL_ACTIVITY });
    const start = activityStart({ date: DATE, time: '09:00' });
    expect(start.toISOString()).toBe('2026-11-21T13:00:00.000Z');
    const at = (iso: string) => ({ now: new Date(iso) });
    expect(blocksOf(meeting, at('2026-11-21T12:59:59Z'))).toEqual([]);
    expect(blocksOf(meeting, at('2026-11-21T13:00:00Z'))).toEqual([block]);
    expect(blocksOf(meeting, at('2026-11-21T14:00:00Z'))).toEqual([block]);
    const sched = (iso: string) => ({ scheduledFor: new Date(iso) });
    expect(blocksOf(meeting, sched('2026-11-21T12:59:59Z'))).toEqual([]);
    expect(blocksOf(meeting, sched('2026-11-21T13:00:00Z'))).toEqual([block]);
    const noTime = request('alignment', { activity: { date: DATE } });
    expect(codes(blocksOf(noTime, at('2026-11-22T00:00:00Z')))).toEqual([
      'missing_activity',
    ]);
  });
});

describe('blocksFor: início do turno e ordem', () => {
  it('schedule_in_past quando o início do turno já passou', () => {
    const block = {
      code: 'team_whatsapp.schedule_in_past',
      message: 'O início deste turno já passou',
    };
    const notice = request('shift_notice', { when: 'shift_start' });
    const at = (ms: number) => ({ scheduledFor: new Date(NOW.getTime() + ms) });
    expect(blocksOf(notice, at(-60_000))).toEqual([block]);
    expect(blocksOf(notice, at(0))).toEqual([block]);
    expect(blocksOf(notice, at(60_000))).toEqual([]);
    expect(blocksOf(notice, { scheduledFor: null })).toEqual([]);
  });

  it('blocos saem na ordem do CF4; empty_text com texto só de espaços', () => {
    const all = {
      receivingCount: 0,
      numbersMissing: true,
      scheduledFor: new Date('2026-11-21T13:30:00Z'),
      now: new Date('2026-11-21T14:00:00Z'),
    };
    const activity = { date: DATE, time: '09:00' };
    const overtime = request('overtime', { text: '   ', activity });
    expect(codes(blocksOf(overtime, all))).toEqual([
      'empty_text',
      'missing_activity',
      'overtime_without_selection',
      'schedule_in_past',
      'after_activity_start',
      'no_recipients',
      'sector_without_number',
    ]);
    const urgency = request('urgency', { text: '' });
    expect(codes(blocksOf(urgency, all))).toEqual([
      'empty_text',
      'missing_urgency_reason',
      'schedule_in_past',
      'no_recipients',
      'sector_without_number',
    ]);
  });
});
