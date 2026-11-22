import { describe, it, expect } from 'vitest';
import {
  audienceExcludedSnapshotSchema,
  teamAudiencePreviewSchema,
} from './team-whatsapp.schema';

const person = {
  userId: 'u1',
  name: 'Marina Teste',
  sectorId: 'log',
  sectorName: 'Logística',
  shiftName: 'Dia',
  levelName: null,
};

const rule = {
  purpose: 'meeting',
  base: 'assigned',
  includeOff: true,
  rosterDate: '2026-11-21',
  sectors: [{ id: 'log', name: 'Logística' }],
  shifts: null,
  levels: [],
  withoutLevel: false,
  selectedCount: null,
  activity: { date: '2026-11-21', time: '09:00', place: 'Sala 2' },
  urgencyReason: null,
  when: 'now',
  scheduledFor: null,
  schedulePolicy: null,
};

const preview = (extra: Record<string, unknown> = {}) => ({
  audienceKey: 'a'.repeat(64),
  rule,
  included: [{ ...person, phone: '+5592991110001' }],
  excluded: [{ ...person, userId: 'u2', reason: 'day_off' }],
  blocks: [
    { code: 'team_whatsapp.empty_text', message: 'Escreva a mensagem.' },
  ],
  ...extra,
});

describe('contrato do público (CF3)', () => {
  it('audienceExcludedSnapshotSchema descarta telefone', () => {
    const [saved] = audienceExcludedSnapshotSchema.parse([
      { ...person, reason: 'no_phone', phone: '+5592991110001' },
    ]);
    expect(saved).toEqual({ ...person, reason: 'no_phone' });
    expect(saved).not.toHaveProperty('phone');
  });

  it('prévia valida included com phone e sectorId, excluded com reason e sectorId', () => {
    const noSector = { ...person, sectorId: undefined };
    expect(teamAudiencePreviewSchema.safeParse(preview()).success).toBe(true);
    for (const bad of [
      { included: [{ ...noSector, phone: null }] },
      { included: [person] },
      { excluded: [{ ...noSector, reason: 'day_off' }] },
      { excluded: [person] },
      { excluded: [{ ...person, reason: 'DAY_OFF' }] },
    ]) {
      expect(teamAudiencePreviewSchema.safeParse(preview(bad)).success).toBe(
        false,
      );
    }
  });
});
