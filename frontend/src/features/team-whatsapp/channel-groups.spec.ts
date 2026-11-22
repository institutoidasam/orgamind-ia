import { describe, expect, it } from 'vitest';
import { buildChannelGroups, receivingBySector, type RosterSectorView } from './channel-groups';
import type { TeamSectorChannel } from './schemas';

const channel = (id: string, state: TeamSectorChannel['live']['state'] = 'open'): TeamSectorChannel => ({
  id, name: `Canal ${id}`, phoneE164: `+55929900000${id}`, provider: 'GOZAP',
  live: { state, checkedAt: '2026-11-10T18:05:00.000Z' },
});
const sector = (sectorId: string, name: string, ch: TeamSectorChannel | null): RosterSectorView => ({ sectorId, name, channel: ch });
const counts = new Map([['log', 12], ['exp', 8], ['man', 6]]);

describe('buildChannelGroups', () => {
  it('dois setores em números diferentes viram dois grupos', () => {
    const { groups, missing, block } = buildChannelGroups(
      [sector('log', 'Logística', channel('1')), sector('exp', 'Expedição', channel('2'))], counts,
    );
    expect(groups.map((g) => [g.channel.id, g.sectors])).toEqual([
      ['1', [{ name: 'Logística', count: 12 }]],
      ['2', [{ name: 'Expedição', count: 8 }]],
    ]);
    expect(missing).toEqual([]);
    expect(block).toBeNull();
  });

  it('dois setores no mesmo número viram um grupo com dois setores', () => {
    const { groups } = buildChannelGroups(
      [sector('log', 'Logística', channel('1')), sector('exp', 'Expedição', channel('1'))], counts,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].sectors).toEqual([{ name: 'Logística', count: 12 }, { name: 'Expedição', count: 8 }]);
  });

  it('setor sem pessoas na lista entra com contagem zero', () => {
    const { groups } = buildChannelGroups([sector('x', 'Compras', channel('1'))], counts);
    expect(groups[0].sectors).toEqual([{ name: 'Compras', count: 0 }]);
  });

  it.each([
    ['sem número', [sector('man', 'Manutenção', null), sector('log', 'Logística', channel('1'))], 'missing'],
    ['close', [sector('log', 'Logística', channel('1', 'close'))], 'disconnected'],
    ['connecting', [sector('log', 'Logística', channel('1', 'connecting'))], 'disconnected'],
    ['unknown', [sector('log', 'Logística', channel('1', 'unknown'))], 'unverified'],
    ['open', [sector('log', 'Logística', channel('1'))], null],
    // O desconectado vence o sem resposta (como no servidor); sem número vence os dois.
    ['close e unknown', [sector('log', 'Logística', channel('1', 'unknown')), sector('exp', 'Expedição', channel('2', 'close'))], 'disconnected'],
    ['sem número e close', [sector('man', 'Manutenção', null), sector('log', 'Logística', channel('1', 'close'))], 'missing'],
  ] as const)('%s → block %s', (_name, sectors, expected) => {
    const result = buildChannelGroups(sectors as readonly RosterSectorView[], counts);
    expect(result.block).toBe(expected);
    if (expected === 'missing') expect(result.missing).toEqual([{ id: 'man', name: 'Manutenção' }]);
  });
});

describe('receivingBySector', () => {
  it('conta, por setor, só quem está na lista de quem recebe', () => {
    const roster = [
      { sectorId: 'log', members: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] },
      { sectorId: 'exp', members: [{ id: 'd' }] },
    ];
    const map = receivingBySector(roster, [{ id: 'a' }, { id: 'c' }, { id: 'd' }, { id: 'z' }]);
    expect(Object.fromEntries(map)).toEqual({ log: 2, exp: 1 });
  });
});
