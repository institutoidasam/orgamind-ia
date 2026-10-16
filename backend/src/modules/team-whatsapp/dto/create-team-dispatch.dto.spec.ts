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
