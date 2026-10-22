import { describe, it, expect } from 'vitest';
import { createTeamDispatchSchema } from './create-team-dispatch.dto';

const base = { channelId: 'c', text: 'oi' };
const DATE = '2026-10-21';

describe('createTeamDispatchSchema', () => {
  it.each([
    { ...base, target: { type: 'user', userId: 'u' } },
    { ...base, target: { type: 'sector', sectorId: 's', date: DATE } },
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
    { ...base, target: { type: 'sector', sectorId: '', date: DATE } },
    { ...base, channelId: '', target: { type: 'user', userId: 'u' } },
    { text: 'oi', target: { type: 'user', userId: 'u' } },
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
    ...base,
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
    ...base,
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
    ...base,
    target: { type: 'sector', sectorId: 's', ...extra },
  });

  it.each([
    [
      'includeOff com shiftId → falha',
      { date: DATE, shiftId: 'shift_first', includeOff: true },
      false,
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
      { when: 'shift_start', target: sector },
      false,
    ],
    [
      'when shift_start com alvo pessoa → falha',
      { when: 'shift_start', target: { type: 'user', userId: 'u' } },
      false,
    ],
    [
      'when shift_start com setor e shiftId → aceita',
      { when: 'shift_start', target: { ...sector, shiftId: 'shift_first' } },
      true,
    ],
    ["when 'later' → falha", { when: 'later', target: sector }, false],
    ['sem when → aceita (agora)', { target: sector }, true],
  ])('%s', (_caso, extra, ok) => {
    expect(
      createTeamDispatchSchema.safeParse({ ...base, ...extra }).success,
    ).toBe(ok);
  });
});
