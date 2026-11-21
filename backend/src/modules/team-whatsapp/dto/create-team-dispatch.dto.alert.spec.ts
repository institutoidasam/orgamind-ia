import { describe, expect, it } from 'vitest';
import { ALERT_CONFIRM_SUFFIX } from '../team-alert.rules';
import {
  createTeamDispatchSchema,
  teamAudienceRequestSchema,
} from './create-team-dispatch.dto';

const KEY = 'a'.repeat(64);
const SECTOR = { type: 'sector', sectorIds: ['s'], date: '2026-10-21' };
const LIMIT = 2000;
const URGENCY_MAX = LIMIT - ALERT_CONFIRM_SUFFIX.length;
const send = (purpose: string, length: number) =>
  createTeamDispatchSchema.safeParse({
    purpose,
    audienceKey: KEY,
    text: 'x'.repeat(length),
    target: SECTOR,
  });
const failingPaths = (r: ReturnType<typeof send>) =>
  r.success ? [] : r.error.issues.map((i) => i.path.join('.'));

describe('createTeamDispatchSchema — limite do texto do alerta (I2, DI3)', () => {
  it('aceite 13: Urgência com 1959 caracteres — aceito (2000 com a linha)', () => {
    expect(URGENCY_MAX).toBe(1959);
    expect(send('urgency', URGENCY_MAX).success).toBe(true);
  });

  it('aceite 13: Urgência com 1960 — 400 no caminho text', () => {
    const r = send('urgency', URGENCY_MAX + 1);

    expect(failingPaths(r)).toEqual(['text']);
    expect(!r.success && r.error.issues[0].message).toBe(
      'Com a linha de confirmação, o texto passa de 2000 caracteres',
    );
  });

  it('reunião com 2000 — aceito, como hoje', () => {
    expect(send('meeting', LIMIT).success).toBe(true);
    expect(failingPaths(send('meeting', LIMIT + 1))).toEqual(['text']);
  });

  it('a prévia da Urgência segue aceitando 2000 (não cobre o texto)', () => {
    const r = teamAudienceRequestSchema.safeParse({
      purpose: 'urgency',
      text: 'x'.repeat(LIMIT),
      target: SECTOR,
    });

    expect(r.success).toBe(true);
  });
});
