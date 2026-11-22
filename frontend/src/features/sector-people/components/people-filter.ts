import { authorizationFlag } from '@/features/people-record/authorization';
import type { SectorPerson } from '../schemas';

/** O que o selo da linha sinaliza; o filtro e o contador usam os mesmos dois valores. */
export type FlagFilter = 'unverified' | 'not_authorized';
export type FlagCounts = Record<FlagFilter, number>;

/** Sem acento e sem caixa: "joao" acha "João". */
const fold = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** Contador do selo sobre a lista carregada (spec A2). */
export function countFlags(people: readonly SectorPerson[]): FlagCounts {
  const counts: FlagCounts = { unverified: 0, not_authorized: 0 };
  for (const person of people) {
    const flag = authorizationFlag(person.contactAuthorization);
    if (flag) counts[flag] += 1;
  }
  return counts;
}

/** Busca local por nome ou matrícula, mais o filtro do selo, sobre a lista carregada (spec A1 e A2). */
export function filterPeople(people: readonly SectorPerson[], { query, flag }: { query: string; flag: FlagFilter | null }): SectorPerson[] {
  const needle = fold(query.trim());
  return people.filter((person) => {
    if (flag && authorizationFlag(person.contactAuthorization) !== flag) return false;
    return needle === '' || fold(`${person.name} ${person.registration ?? ''}`).includes(needle);
  });
}
