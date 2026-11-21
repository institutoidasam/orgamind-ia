import { describe, expect, it } from 'vitest';
import {
  teamPanoramaQuerySchema,
  teamPanoramaResponseSchema,
} from './team-panorama.schema';

const counts = {
  byShift: [{ shiftId: 'manha', count: 3 }],
  otherShifts: 1,
  dayOff: 2,
  vacation: 0,
  noSchedule: 4,
  noPhone: 1,
  notAuthorized: 0,
};
const manha = {
  id: 'manha',
  name: 'Manhã',
  startTime: '07:00',
  endTime: '15:00',
};

describe('teamPanoramaResponseSchema', () => {
  it('aceite 3: resposta com counts e overLimit; chave extra de pessoa (name, phoneE164) é descartada', () => {
    const parsed = teamPanoramaResponseSchema.parse({
      date: '2026-11-20',
      today: '2026-11-20',
      shifts: [manha],
      inProgress: null,
      sectors: [
        {
          sectorId: 's1',
          name: 'Produção',
          overLimit: false,
          counts: { ...counts, name: 'Pessoa A', phoneE164: '+5592991110001' },
          phoneE164: '+5592991110001',
        },
        { sectorId: 's2', name: 'Logística', overLimit: true, counts: null },
      ],
    });

    expect(parsed.sectors[0]).toEqual({
      sectorId: 's1',
      name: 'Produção',
      overLimit: false,
      counts,
    });
    expect(parsed.sectors[1]).toEqual({
      sectorId: 's2',
      name: 'Logística',
      overLimit: true,
      counts: null,
    });
  });
});

describe('teamPanoramaQuerySchema', () => {
  it('query sem date ou com 2026-02-30 falha', () => {
    expect(teamPanoramaQuerySchema.safeParse({}).success).toBe(false);
    expect(
      teamPanoramaQuerySchema.safeParse({ date: '2026-02-30' }).success,
    ).toBe(false);
    expect(teamPanoramaQuerySchema.parse({ date: '2026-11-20' })).toEqual({
      date: '2026-11-20',
    });
  });
});
