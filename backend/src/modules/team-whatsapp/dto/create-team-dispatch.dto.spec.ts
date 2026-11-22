import { describe, it, expect } from 'vitest';
import {
  createTeamDispatchSchema,
  teamAudienceRequestSchema,
} from './create-team-dispatch.dto';

const base = { channelId: 'c', text: 'oi' };
const DATE = '2026-10-21';
const KEY = 'a'.repeat(64);
// Envio para setor (CF2): finalidade e impressão do público vinda da prévia.
const SEND = { purpose: 'shift_notice', audienceKey: KEY };
const sectorBase = { ...base, ...SEND };
const SECTOR = { type: 'sector', sectorIds: ['s'], date: DATE };
const USER = { type: 'user', userId: 'u' };
type Body = Record<string, unknown>;
const preview = (extra: Body = {}, target: Body = {}) =>
  teamAudienceRequestSchema.safeParse({
    text: 'oi',
    purpose: 'meeting',
    ...extra,
    target: { ...SECTOR, ...target },
  });
const send = (extra: Body = {}, target: Body = SECTOR) =>
  createTeamDispatchSchema.safeParse({ text: 'oi', ...extra, target });
const failingPaths = (r: ReturnType<typeof send>) =>
  r.success ? [] : r.error.issues.map((i) => i.path.join('.'));

describe('teamAudienceRequestSchema — audienceKey ignorada tem limite', () => {
  it('prévia recusa audienceKey com 65 caracteres e aceita 64', () => {
    expect(failingPaths(preview({ audienceKey: 'a'.repeat(65) }))).toEqual([
      'audienceKey',
    ]);
    expect(preview({ audienceKey: 'a'.repeat(64) }).success).toBe(true);
  });
});

describe('teamAudienceRequestSchema — corpo da prévia (CF2)', () => {
  it('prévia aceita texto vazio, userIds vazio e atividade incompleta', () => {
    const r = preview({ text: '', activity: { date: DATE } }, { userIds: [] });
    expect(r.success).toBe(true);
  });

  it('prévia recusa alvo pessoa, exige purpose e ignora audienceKey', () => {
    expect(preview({}, USER).success).toBe(false);
    expect(failingPaths(preview({ purpose: undefined }))).toEqual(['purpose']);
    expect(preview({ audienceKey: 'qualquer' }).success).toBe(true);
  });

  it('aliases sectorId e shiftId continuam', () => {
    const alias = { sectorIds: undefined, sectorId: 's', shiftId: 'd' };
    const r = preview({}, alias);
    expect(r.success && r.data.target).toEqual({ ...SECTOR, shiftIds: ['d'] });
    const sent = send(SEND, { ...SECTOR, ...alias });
    expect(sent.success && sent.data.target).toEqual(
      r.success && r.data.target,
    );
  });

  it('includeOff com shiftIds agora passa', () => {
    const offWithShifts = { shiftIds: ['d', 'n'], includeOff: true };
    expect(preview({}, offWithShifts).success).toBe(true);
    expect(send(SEND, { ...SECTOR, ...offWithShifts }).success).toBe(true);
  });
});

describe('createTeamDispatchSchema — finalidade no envio (CF2, DF7, GF1)', () => {
  it('envio para setor exige purpose e audienceKey hex de 64', () => {
    expect(send(SEND).success).toBe(true);
    expect(failingPaths(send({ audienceKey: KEY }))).toEqual(['purpose']);
    expect(failingPaths(send({ purpose: 'meeting' }))).toEqual(['audienceKey']);
    for (const bad of ['A'.repeat(64), 'a'.repeat(63), 'g'.repeat(64)]) {
      const r = send({ ...SEND, audienceKey: bad });
      expect(failingPaths(r)).toEqual(['audienceKey']);
    }
  });

  it('envio para setor aceita texto vazio (vira trava) e recusa userIds vazio', () => {
    expect(send({ ...SEND, text: '' }).success).toBe(true);
    expect(send({ ...SEND, text: '   ' }).success).toBe(true);
    const noOne = send(SEND, { ...SECTOR, userIds: [] });
    expect(failingPaths(noOne)).toEqual(['target.userIds']);
  });

  it('alvo pessoa com purpose é recusado; sem purpose passa como hoje', () => {
    expect(failingPaths(send({ purpose: 'meeting' }, USER))).toEqual([
      'purpose',
    ]);
    expect(send({}, USER).success).toBe(true);
    expect(failingPaths(send({ text: '  ' }, USER))).toEqual(['text']);
  });
});

describe('createTeamDispatchSchema — atividade e urgência (GF11)', () => {
  it('local com 121 e motivo com 201 caracteres são recusados; aparados antes de medir', () => {
    const place = ` ${'x'.repeat(120)} `;
    const reason = ` ${'y'.repeat(200)} `;
    const ok = send({ ...SEND, activity: { place }, urgencyReason: reason });
    expect(ok.success && ok.data.activity?.place).toBe('x'.repeat(120));
    expect(ok.success && ok.data.urgencyReason).toBe('y'.repeat(200));
    const long = send({
      ...SEND,
      activity: { place: 'x'.repeat(121) },
      urgencyReason: 'y'.repeat(201),
    });
    expect(failingPaths(long)).toEqual(['activity.place', 'urgencyReason']);
  });

  it('hora fora de HH:mm é recusada', () => {
    for (const time of ['9:00', '24:00', '09:60', '09h00']) {
      const r = send({ ...SEND, activity: { time } });
      expect(failingPaths(r)).toEqual(['activity.time']);
    }
    const ok = send({ ...SEND, activity: { date: DATE, time: '23:59' } });
    expect(ok.success).toBe(true);
  });
});

describe('createTeamDispatchSchema', () => {
  it.each([
    { ...base, target: { type: 'user', userId: 'u' } },
    { ...sectorBase, target: { type: 'sector', sectorId: 's', date: DATE } },
    { ...base, text: 'x'.repeat(2000), target: { type: 'user', userId: 'u' } },
  ])('aceita corpo válido #%#', (body) => {
    expect(createTeamDispatchSchema.safeParse(body).success).toBe(true);
  });

  it.each([
    { ...base, text: '', target: { type: 'user', userId: 'u' } },
    { ...base, text: '   ', target: { type: 'user', userId: 'u' } },
    { ...base, text: 'x'.repeat(2001), target: { type: 'user', userId: 'u' } },
    { ...base, target: { type: 'all' } },
    { ...base, target: { type: 'user' } },
    { ...sectorBase, target: { type: 'sector', sectorId: '', date: DATE } },
  ])('recusa corpo inválido #%#', (body) => {
    expect(createTeamDispatchSchema.safeParse(body).success).toBe(false);
  });

  it('não apara o texto (só-espaços é inválido, espaços em volta ficam)', () => {
    const parsed = createTeamDispatchSchema.parse({
      ...base,
      text: '  oi  ',
      target: { type: 'user', userId: 'u' },
    });
    expect(parsed.text).toBe('  oi  ');
  });
});

describe('createTeamDispatchSchema — alvo setor com turno e seleção', () => {
  const toSector = (extra: Record<string, unknown>) => ({
    ...sectorBase,
    target: { type: 'sector', sectorId: 's', date: DATE, ...extra },
  });
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `u${i}`);

  it.each([
    ['recusa userIds vazio', { userIds: [] }, false],
    ['recusa 501 ids', { userIds: ids(501) }, false],
    ['recusa id vazio', { userIds: [''] }, false],
    ['recusa shiftId vazio', { shiftId: '' }, false],
    [
      'aceita turno e seleção',
      { shiftId: 'shift_first', userIds: ['u1'] },
      true,
    ],
    ['aceita 500 ids', { userIds: ids(500) }, true],
    ['aceita sem extras', {}, true],
  ])('%s', (_caso, extra, ok) => {
    expect(createTeamDispatchSchema.safeParse(toSector(extra)).success).toBe(
      ok,
    );
  });

  it('o enum legado `shift` não é mais aceito como filtro: é descartado', () => {
    const parsed = createTeamDispatchSchema.parse(toSector({ shift: 'FIRST' }));
    expect(parsed.target).toEqual({
      type: 'sector',
      sectorIds: ['s'],
      date: DATE,
    });
  });
});

describe('createTeamDispatchSchema — vários setores e nível (C5)', () => {
  const sectors = (target: Record<string, unknown>) => ({
    ...sectorBase,
    target: { type: 'sector', date: DATE, ...target },
  });
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `x${i}`);

  it.each([
    ['sectorIds vazio → falha', { sectorIds: [] }, false],
    ['101 setores → falha', { sectorIds: ids(101) }, false],
    ['levelIds com 51 → falha', { sectorIds: ['s'], levelIds: ids(51) }, false],
    [
      'sectorId e sectorIds juntos → falha',
      { sectorId: 's', sectorIds: ['t'] },
      false,
    ],
    [
      'setores, níveis e sem nível → aceita',
      { sectorIds: ids(100), levelIds: ids(50), withoutLevel: true },
      true,
    ],
  ])('%s', (_caso, target, ok) => {
    expect(createTeamDispatchSchema.safeParse(sectors(target)).success).toBe(
      ok,
    );
  });
});

describe('createTeamDispatchSchema — alvo setor por data (C7)', () => {
  const sectorTarget = (extra: Record<string, unknown>) => ({
    ...sectorBase,
    target: { type: 'sector', sectorId: 's', ...extra },
  });

  it.each([
    [
      'includeOff com shiftId → aceita',
      { date: DATE, shiftId: 'shift_first', includeOff: true },
      true,
    ],
    ["date '2026-02-30' → falha", { date: '2026-02-30' }, false],
    ['alvo setor sem date → falha', {}, false],
    ['includeOff sem shiftId → aceita', { date: DATE, includeOff: true }, true],
  ])('%s', (_caso, extra, ok) => {
    expect(
      createTeamDispatchSchema.safeParse(sectorTarget(extra)).success,
    ).toBe(ok);
  });
});

describe('createTeamDispatchSchema — quando enviar (C7)', () => {
  const sector = { type: 'sector', sectorId: 's', date: DATE };

  it.each([
    [
      'when shift_start sem shiftId → falha',
      { ...SEND, when: 'shift_start', target: sector },
      false,
    ],
    [
      'when shift_start com alvo pessoa → falha',
      { when: 'shift_start', target: { type: 'user', userId: 'u' } },
      false,
    ],
    [
      'when shift_start com setor e shiftId → aceita',
      {
        ...SEND,
        when: 'shift_start',
        target: { ...sector, shiftId: 'shift_first' },
      },
      true,
    ],
    ["when 'later' → falha", { ...SEND, when: 'later', target: sector }, false],
    ['sem when → aceita (agora)', { ...SEND, target: sector }, true],
  ])('%s', (_caso, extra, ok) => {
    expect(
      createTeamDispatchSchema.safeParse({ ...base, ...extra }).success,
    ).toBe(ok);
  });
});

const D = 'shift_day';
const N = 'shift_night';
const turnos = (target: Record<string, unknown>, extra = {}) => ({
  ...sectorBase,
  ...extra,
  target: { type: 'sector', sectorIds: ['s'], date: DATE, ...target },
});
const many = (n: number) => Array.from({ length: n }, (_, i) => `t${i}`);

describe('createTeamDispatchSchema — vários turnos (C3)', () => {
  // Sem caminho = aceita; com caminho = recusa (400) naquele campo.
  it.each<[string, Record<string, unknown>, string | undefined]>([
    ['shiftIds [D, N] → aceita', turnos({ shiftIds: [D, N] }), undefined],
    ['20 turnos → aceita', turnos({ shiftIds: many(20) }), undefined],
    [
      'shiftId e shiftIds juntos → 400',
      turnos({ shiftId: D, shiftIds: [N] }),
      'shiftId',
    ],
    [
      'includeOff com shiftIds → aceita',
      turnos({ shiftIds: [D, N], includeOff: true }),
      undefined,
    ],
    [
      'shift_start com 2 turnos → 400',
      turnos({ shiftIds: [D, N] }, { when: 'shift_start' }),
      'when',
    ],
    [
      'shift_start com 1 turno → aceita',
      turnos({ shiftIds: [D] }, { when: 'shift_start' }),
      undefined,
    ],
    ['21 turnos → 400', turnos({ shiftIds: many(21) }), 'shiftIds'],
    ['channelId presente → aceita', turnos({}, { channelId: 'c9' }), undefined],
    [
      'sem channelId → aceita',
      { ...SEND, text: 'oi', target: turnos({}).target },
      undefined,
    ],
  ])('%s', (_caso, body, failingPath) => {
    const result = createTeamDispatchSchema.safeParse(body);
    expect(result.success).toBe(failingPath === undefined);
    if (!result.success) {
      expect(result.error.issues.map((i) => i.path.at(-1))).toContain(
        failingPath,
      );
    }
  });
});

describe('createTeamDispatchSchema — apelido shiftId (D9)', () => {
  it('shiftId sozinho vira shiftIds [shiftId], sem a chave antiga', () => {
    const { target } = createTeamDispatchSchema.parse(turnos({ shiftId: D }));
    expect(target).toMatchObject({ shiftIds: [D] });
    expect(target).not.toHaveProperty('shiftId');
  });
});
