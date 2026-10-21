import { describe, it, expect } from 'vitest';
import { createTeamDispatchSchema } from './create-team-dispatch.dto';

const base = { channelId: 'c', text: 'oi' };

describe('createTeamDispatchSchema', () => {
  it.each([
    { ...base, target: { type: 'user', userId: 'u' } },
    { ...base, target: { type: 'sector', sectorId: 's' } },
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
    { ...base, target: { type: 'sector', sectorId: '' } },
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
    target: { type: 'sector', sectorId: 's', ...extra },
  });
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `u${i}`);

  it.each([
    ['recusa userIds vazio', { userIds: [] }, false],
    ['recusa 501 ids', { userIds: ids(501) }, false],
    ['recusa id vazio', { userIds: [''] }, false],
    ['recusa turno desconhecido', { shift: 'THIRD' }, false],
    ['aceita turno e seleção', { shift: 'FIRST', userIds: ['u1'] }, true],
    ['aceita 500 ids', { userIds: ids(500) }, true],
    ['aceita sem extras', {}, true],
  ])('%s', (_caso, extra, ok) => {
    expect(createTeamDispatchSchema.safeParse(toSector(extra)).success).toBe(
      ok,
    );
  });
});
