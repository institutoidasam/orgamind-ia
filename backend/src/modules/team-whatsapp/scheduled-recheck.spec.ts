import { describe, expect, it } from 'vitest';
import {
  classifySector,
  type AudienceEntry,
  type AudienceFilter,
  type AudienceRuleReason,
} from './audience-classify';
import {
  planRecheck,
  type FrozenRecipient,
  type RecheckPlan,
} from './scheduled-recheck';
import { buildAudience } from './team-whatsapp.audience';
import { dayPerson } from './team-whatsapp.test-fixtures';

const S1 = { id: 's1', name: 'Financeiro' };

/** Entrada já classificada (saída de `classifySector`); `reason` nulo = entra. */
const entry = (
  id: string,
  reason: AudienceRuleReason | null = null,
  over: Partial<AudienceEntry> = {},
  name = id,
): AudienceEntry => ({
  member: dayPerson({ id, name }),
  sectorId: S1.id,
  sectorName: S1.name,
  shiftId: null,
  shiftName: null,
  levelName: null,
  reason,
  ...over,
});

const frozenOf = (
  userId: string | null,
  over: Partial<FrozenRecipient> = {},
): FrozenRecipient => ({
  id: `r-${userId}`,
  userId,
  userActive: true,
  ...over,
});

/** Reconfere com o público dado; `recipientUserIds` padrão = usuários de `frozen`. */
const recheck = (
  entries: AudienceEntry[],
  frozen: FrozenRecipient[],
  over: { recipientUserIds?: string[]; selectionWasAll?: boolean } = {},
): RecheckPlan =>
  planRecheck({
    frozen,
    recipientUserIds: new Set(
      over.recipientUserIds ??
        frozen.flatMap((f) => (f.userId ? [f.userId] : [])),
    ),
    audience: buildAudience({ sectors: [entries], userIds: undefined }),
    selectionWasAll: over.selectionWasAll ?? false,
  });

const skipsOf = (plan: RecheckPlan) =>
  Object.fromEntries(plan.skips.map((s) => [s.recipientId, s.reason]));

const DAY_OFF = {
  cycle: { startDate: '2026-01-01', cycleLength: 1, days: [null] },
};

/** O que `classifySector` devolve para o setor, base vinculada, na data da reconferência. */
const classified = (
  people: Parameters<typeof classifySector>[0]['people'],
  filter: Partial<AudienceFilter> = {},
) =>
  classifySector({
    base: 'assigned',
    sector: S1,
    date: '2026-11-20',
    people,
    filter: {
      shiftIds: null,
      includeOff: false,
      level: null,
      shiftNames: new Map(),
      ...filter,
    },
  });

describe('planRecheck: motivos', () => {
  it('aceite 21: incluído na criação e de férias agora — VACATION', () => {
    const plan = recheck(
      [entry('u1', 'vacation'), entry('u2')],
      [frozenOf('u1'), frozenOf('u2')],
    );

    expect(skipsOf(plan)).toEqual({ 'r-u1': 'VACATION' });
  });

  it('aceite 32: outro turno — LEFT_SECTOR', () => {
    const plan = recheck([entry('u1', 'other_shift')], [frozenOf('u1')]);

    expect(skipsOf(plan)).toEqual({ 'r-u1': 'LEFT_SECTOR' });
  });

  it('aceite 34: ausente do público — LEFT_SECTOR', () => {
    const plan = recheck([entry('u2')], [frozenOf('u1'), frozenOf('u2')]);

    expect(skipsOf(plan)).toEqual({ 'r-u1': 'LEFT_SECTOR' });
  });
});

describe('planRecheck: motivos pela escala e pelo nível', () => {
  it('troca de nível depois, fora do filtro gravado — LEFT_SECTOR', () => {
    const level = { levelIds: new Set(['l1']), withoutLevel: false };
    const people = [
      dayPerson({ id: 'u1', name: 'u1', sectorId: S1.id, levelId: 'l2' }),
      dayPerson({ id: 'u2', name: 'u2', sectorId: S1.id, levelId: 'l1' }),
    ];

    const plan = recheck(classified(people, { level }), [
      frozenOf('u1'),
      frozenOf('u2'),
    ]);

    expect(skipsOf(plan)).toEqual({ 'r-u1': 'LEFT_SECTOR' });
  });

  it('aceite 39: de folga agora sem includeOff — DAY_OFF', () => {
    const people = [
      dayPerson({ id: 'u1', name: 'u1', sectorId: S1.id, ...DAY_OFF }),
    ];

    const plan = recheck(classified(people), [frozenOf('u1')]);

    expect(skipsOf(plan)).toEqual({ 'r-u1': 'DAY_OFF' });
  });

  it('aceite 23: de folga agora com includeOff — fica', () => {
    const people = [
      dayPerson({ id: 'u1', name: 'u1', sectorId: S1.id, ...DAY_OFF }),
    ];

    const plan = recheck(classified(people, { includeOff: true }), [
      frozenOf('u1'),
    ]);

    expect(plan.skips).toEqual([]);
  });
});

describe('planRecheck: precedência', () => {
  it('inativo ou sem usuário — INACTIVE, antes de qualquer outro motivo', () => {
    const plan = recheck(
      [entry('u1', 'vacation'), entry('u2')],
      [
        frozenOf('u1', { userActive: false }),
        frozenOf('u2', { userActive: false }),
        frozenOf(null),
      ],
    );

    expect(skipsOf(plan)).toEqual({
      'r-u1': 'INACTIVE',
      'r-u2': 'INACTIVE',
      'r-null': 'INACTIVE',
    });
  });

  it('excluído por telefone no recálculo não é pulado aqui', () => {
    const noPhone = entry('u1');
    noPhone.member = dayPerson({ id: 'u1', name: 'u1', phoneE164: null });

    const plan = recheck([noPhone], [frozenOf('u1')]);

    expect(plan.skips).toEqual([]);
  });

  it('nenhum skip cita recipientId fora de frozen', () => {
    const entries = [
      entry('u1', 'day_off'),
      entry('u2', 'vacation'),
      entry('u3', 'other_sector'),
    ];

    const plan = recheck(entries, [frozenOf('u1')], {
      recipientUserIds: ['u1', 'u2', 'u3'],
      selectionWasAll: true,
    });

    expect(plan.skips).toEqual([{ recipientId: 'r-u1', reason: 'DAY_OFF' }]);
  });
});

describe('planRecheck: entraram depois', () => {
  const late = (id: string, name: string) =>
    entry(id, null, { shiftName: '1º turno', levelName: 'Nível 1' }, name);

  it('aceite 22: todos os aptos — incluído novo sem linha vai para lateJoined, sem telefone, ordenado', () => {
    const entries = [entry('u1'), late('u3', 'Zélia'), late('u2', 'Bruno')];

    const plan = recheck(entries, [frozenOf('u1')], { selectionWasAll: true });

    expect(plan.skips).toEqual([]);
    const where = {
      sectorId: 's1',
      sectorName: 'Financeiro',
      shiftName: '1º turno',
      levelName: 'Nível 1',
    };
    expect(plan.lateJoined).toEqual([
      { userId: 'u2', name: 'Bruno', ...where },
      { userId: 'u3', name: 'Zélia', ...where },
    ]);
  });

  it('seleção nominal — lateJoined vazio', () => {
    const plan = recheck([entry('u1'), late('u2', 'Bruno')], [frozenOf('u1')]);

    expect(plan.lateJoined).toEqual([]);
  });

  it('quem já tem linha SKIPPED de telefone não entra em lateJoined', () => {
    const plan = recheck([entry('u1'), late('u2', 'Bruno')], [frozenOf('u1')], {
      recipientUserIds: ['u1', 'u2'],
      selectionWasAll: true,
    });

    expect(plan.lateJoined).toEqual([]);
  });
});

describe('planRecheck: entraram depois (excluídos e desempate)', () => {
  it('excluído por férias ou folga sem linha no envio não entra em lateJoined', () => {
    const entries = [
      entry('u1'),
      entry('u2', 'vacation'),
      entry('u3', 'day_off'),
    ];

    const plan = recheck(entries, [frozenOf('u1')], {
      recipientUserIds: ['u1'],
      selectionWasAll: true,
    });

    expect(plan.skips).toEqual([]);
    expect(plan.lateJoined).toEqual([]);
  });

  it('nomes iguais: lateJoined desempata pelo userId, não pela ordem de chegada', () => {
    const entries = [
      entry('u1'),
      entry('u9', null, {}, 'Ana'),
      entry('u2', null, {}, 'Ana'),
      entry('u5', null, {}, 'Ana'),
    ];

    const plan = recheck(entries, [frozenOf('u1')], { selectionWasAll: true });

    expect(plan.lateJoined.map((p) => p.userId)).toEqual(['u2', 'u5', 'u9']);
  });
});
