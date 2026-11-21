import { DomainError } from '../../shared/errors/domain.error';
import type { CivilDate } from '../staff-schedule/civil-date';
import type {
  TeamMemberWithSchedule,
  TeamWhatsappRepository,
} from './team-whatsapp.repository';

/** Pessoas do dia por setor do alcance; `over_limit` = o setor sozinho passa do teto. */
export type PanoramaDays = Map<string, TeamMemberWithSchedule[] | 'over_limit'>;

type DayPeopleRepo = Pick<TeamWhatsappRepository, 'loadDayPeopleMany'>;

const isTooManyPeople = (e: unknown): boolean =>
  e instanceof DomainError && e.code === 'team_whatsapp.too_many_people';

/** Um setor por chamada, em série (não soma carga no banco); só o que estoura sozinho fica de fora. */
async function oneSectorAtATime(
  repo: DayPeopleRepo,
  sectorIds: readonly string[],
  date: CivilDate,
  today: CivilDate,
): Promise<PanoramaDays> {
  const days: PanoramaDays = new Map();
  for (const id of sectorIds) {
    try {
      const people = await repo.loadDayPeopleMany([id], date, today);
      days.set(id, people.get(id) ?? []);
    } catch (e) {
      if (!isTooManyPeople(e)) throw e;
      days.set(id, 'over_limit');
    }
  }
  return days;
}

/**
 * Pessoas do dia do alcance (DJ3): uma rodada só para todos os setores; o teto
 * de `DAY_PEOPLE_LIMIT` é por chamada, então quando a rodada estoura refaz setor
 * a setor. Qualquer outro erro propaga. Quem entra em cada setor decide
 * `dayMembers`, como no roster.
 */
export async function loadPanoramaDays(
  repo: DayPeopleRepo,
  sectorIds: readonly string[],
  date: CivilDate,
  today: CivilDate,
): Promise<PanoramaDays> {
  if (sectorIds.length === 0) return new Map();
  try {
    const people = await repo.loadDayPeopleMany(sectorIds, date, today);
    return new Map(sectorIds.map((id) => [id, people.get(id) ?? []]));
  } catch (e) {
    if (!isTooManyPeople(e)) throw e;
    return oneSectorAtATime(repo, sectorIds, date, today);
  }
}
