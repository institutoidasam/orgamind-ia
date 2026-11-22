import { describe, expect, it, vi } from 'vitest';
import { loadPanoramaDays } from './team-panorama.load';
import { tooManyPeople } from './team-whatsapp.errors';
import type { TeamMemberWithSchedule } from './team-whatsapp.repository';
import { dayPerson } from './team-whatsapp.test-fixtures';

// DJ3: uma rodada para o alcance inteiro; o teto de 2000 é por chamada, então
// estourar na rodada refaz setor a setor, em série, e só o setor que sozinho
// estoura fica `over_limit`.
const DATE = '2026-11-20';
const TODAY = '2026-11-21';
type People = Map<string, TeamMemberWithSchedule[]>;
const ana = dayPerson({ id: 'u1', sectorId: 's1' });
const bia = dayPerson({ id: 'u2', sectorId: 's2' });

/** Repositório falso: `respond` decide cada chamada pelos ids pedidos. */
function repoWith(respond: (ids: readonly string[]) => People) {
  const events: string[] = [];
  const loadDayPeopleMany = vi.fn(async (ids: readonly string[]) => {
    events.push(`start ${ids.join(',')}`);
    await Promise.resolve();
    events.push(`end ${ids.join(',')}`);
    return respond(ids);
  });
  return { repo: { loadDayPeopleMany }, events };
}

describe('loadPanoramaDays — rodada única (DJ3)', () => {
  it('uma rodada quando cabe', async () => {
    const { repo } = repoWith(() => new Map([['s1', [ana]]]));
    const days = await loadPanoramaDays(repo, ['s1', 's2'], DATE, TODAY);
    expect(repo.loadDayPeopleMany.mock.calls).toEqual([
      [['s1', 's2'], DATE, TODAY],
    ]);
    expect([...days]).toEqual([
      ['s1', [ana]],
      ['s2', []],
    ]);
  });

  it('alcance vazio não consulta pessoas', async () => {
    const { repo } = repoWith(() => new Map());
    await expect(loadPanoramaDays(repo, [], DATE, TODAY)).resolves.toEqual(
      new Map(),
    );
    expect(repo.loadDayPeopleMany).not.toHaveBeenCalled();
  });
});

describe('loadPanoramaDays — teto de 2000 por chamada (DJ3)', () => {
  it('too_many_people na rodada — refaz setor a setor e marca over_limit só o setor que sozinho estoura', async () => {
    const { repo, events } = repoWith((ids) => {
      if (ids.length > 1 || ids[0] === 's1') throw tooManyPeople();
      return new Map([['s2', [bia]]]);
    });
    const days = await loadPanoramaDays(repo, ['s1', 's2'], DATE, TODAY);
    expect([...days]).toEqual([
      ['s1', 'over_limit'],
      ['s2', [bia]],
    ]);
    expect(repo.loadDayPeopleMany.mock.calls.slice(1)).toEqual([
      [['s1'], DATE, TODAY],
      [['s2'], DATE, TODAY],
    ]);
    // Em série: o setor seguinte só começa depois que o anterior termina.
    expect(events.slice(2)).toEqual([
      'start s1',
      'end s1',
      'start s2',
      'end s2',
    ]);
  });

  it('outro erro propaga', async () => {
    const boom = new Error('banco fora');
    const first = repoWith(() => {
      throw boom;
    });
    await expect(
      loadPanoramaDays(first.repo, ['s1', 's2'], DATE, TODAY),
    ).rejects.toBe(boom);
    const later = repoWith((ids) => {
      if (ids.length > 1) throw tooManyPeople();
      throw boom;
    });
    await expect(
      loadPanoramaDays(later.repo, ['s1', 's2'], DATE, TODAY),
    ).rejects.toBe(boom);
  });
});
