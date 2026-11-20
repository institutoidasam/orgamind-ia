import type { CivilDate } from '../staff-schedule/civil-date';
import {
  classifySector,
  type AudienceBase,
  type AudienceEntry,
  type AudienceFilter,
} from './audience-classify';
import type { TeamMemberWithSchedule } from './team-whatsapp.repository';
import type { LevelFilter } from './team-whatsapp.roster';

/**
 * Nomes de todos os turnos que a escala pode mostrar (T4a-m2): os ativos e os
 * do vínculo de cada pessoa carregada, inclusive inativos; sem isso o turno da
 * escala que ficou inativo sairia sem nome.
 */
export function shiftNamesOf(
  active: readonly { id: string; name: string }[],
  people: readonly TeamMemberWithSchedule[],
): Map<string, string> {
  const names = new Map<string, string>();
  for (const p of people) {
    if (p.shiftId && p.workShift) names.set(p.shiftId, p.workShift.name);
  }
  for (const s of active) names.set(s.id, s.name);
  return names;
}

/**
 * Classificação de cada setor (na ordem de `sectors`), com o mesmo filtro para
 * todos (GF5). Função pura, a mesma da prévia, do envio e da reconferência do
 * agendado: sem ator, sem banco e sem portas de alcance (DG3); quem consulta
 * pessoas, turnos e níveis é o chamador. `shiftIds` nulo ou vazio = todos os
 * turnos; `shiftNames` é o de `shiftNamesOf`; `level` nulo = todos os níveis.
 */
export function classifyPeople(input: {
  base: AudienceBase;
  includeOff: boolean;
  date: CivilDate;
  sectors: readonly { id: string; name: string }[];
  shiftIds: readonly string[] | null;
  shiftNames: ReadonlyMap<string, string>;
  level: LevelFilter | null;
  people: ReadonlyMap<string, TeamMemberWithSchedule[]>;
}): AudienceEntry[][] {
  const { base, date, sectors, people } = input;
  const filter: AudienceFilter = {
    shiftIds: input.shiftIds?.length ? new Set(input.shiftIds) : null,
    includeOff: input.includeOff,
    level: input.level,
    shiftNames: input.shiftNames,
  };
  return sectors.map((sector) =>
    classifySector({
      base,
      sector,
      date,
      people: people.get(sector.id) ?? [],
      filter,
    }),
  );
}
