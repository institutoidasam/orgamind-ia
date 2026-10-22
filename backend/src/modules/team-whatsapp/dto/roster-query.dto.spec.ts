import { describe, expect, it } from 'vitest';
import { RosterQueryDto } from './roster-query.dto';

const teamRosterQuerySchema = RosterQueryDto.schema;

const DATE = '2026-10-21';
const ids = (n: number) => Array.from({ length: n }, (_, i) => `s${i}`);

describe('teamRosterQuerySchema (C4)', () => {
  it('sectorIds por vírgula, repetidos contam uma vez', () => {
    expect(
      teamRosterQuerySchema.parse({ sectorIds: 's1,s2,s1', date: DATE }),
    ).toEqual({ sectorIds: ['s1', 's2'], date: DATE });
  });

  it('100 ids distintos (com repetidos) passam', () => {
    const raw = [...ids(100), 's0', 's1'].join(',');
    const parsed = teamRosterQuerySchema.parse({ sectorIds: raw, date: DATE });
    expect(parsed.sectorIds).toHaveLength(100);
  });

  it('sectorId sozinho = sectorIds [sectorId] (D7)', () => {
    expect(teamRosterQuerySchema.parse({ sectorId: 's1', date: DATE })).toEqual(
      { sectorIds: ['s1'], date: DATE },
    );
  });

  it.each<[string, Record<string, unknown>]>([
    ['sectorIds vazio', { sectorIds: '', date: DATE }],
    ['sem sectorIds nem sectorId', { date: DATE }],
    ['101 ids', { sectorIds: ids(101).join(','), date: DATE }],
  ])('%s → falha', (_caso, query) => {
    expect(teamRosterQuerySchema.safeParse(query).success).toBe(false);
  });
});
