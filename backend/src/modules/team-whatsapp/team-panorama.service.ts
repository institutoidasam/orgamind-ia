import { Injectable } from '@nestjs/common';
import type {
  TeamPanoramaQuery,
  TeamPanoramaResponse,
} from '../../schemas/contracts/team-panorama.schema';
import { todayIn, type CivilDate } from '../staff-schedule/civil-date';
import { panoramaCounts } from './team-panorama.counts';
import { loadPanoramaDays } from './team-panorama.load';
import { teamForbidden } from './team-whatsapp.errors';
import { isTeamSender } from './team-whatsapp.policy';
import {
  TeamWhatsappRepository,
  type TeamMemberWithSchedule,
} from './team-whatsapp.repository';
import { dayMembers } from './team-whatsapp.roster';
import { overnightInProgress } from './team-whatsapp.selection';

type PanoramaSector = TeamPanoramaResponse['sectors'][number];

const byName = new Intl.Collator('pt-BR');

/** Cartão do setor: contagens da escala do dia, ou só o aviso de limite (DJ3). */
function sectorCard(
  sector: { id: string; name: string },
  people: TeamMemberWithSchedule[] | 'over_limit' | undefined,
  date: CivilDate,
  shiftIds: readonly string[],
): PanoramaSector {
  const head = { sectorId: sector.id, name: sector.name };
  if (people === 'over_limit')
    return { ...head, overLimit: true, counts: null };
  const members = dayMembers({
    sectorId: sector.id,
    date,
    people: people ?? [],
  });
  return {
    ...head,
    overLimit: false,
    counts: panoramaCounts(members, shiftIds),
  };
}

/**
 * Panorama dos setores do alcance na data (PAN-01, DJ2): só contagens, sem
 * nome nem telefone de pessoa (GJ3), sem trilha e sem consultar consentimento.
 */
@Injectable()
export class TeamPanoramaService {
  constructor(private readonly repo: TeamWhatsappRepository) {}

  /**
   * Quem não é remetente recebe o 403 do roster antes de qualquer leitura de
   * setor ou pessoa (GJ4). Alcance: ADMIN, todos os setores ativos; os demais,
   * os ativos que gerem. `now` vem do controller (GJ8).
   */
  async panorama(
    actorId: string,
    query: TeamPanoramaQuery,
    now: Date,
  ): Promise<TeamPanoramaResponse> {
    const actor = await this.repo.findActor(actorId);
    if (!actor || !isTeamSender(actor)) throw teamForbidden();
    const onlyIds = actor.role === 'ADMIN' ? null : actor.managedSectorIds;
    const sectors = await this.repo.listSectors(onlyIds);
    const { date } = query;
    const today = todayIn(now);
    const [shifts, days] = await Promise.all([
      this.repo.listActiveShifts(),
      loadPanoramaDays(
        this.repo,
        sectors.map((s) => s.id),
        date,
        today,
      ),
    ]);
    const shiftIds = shifts.map((s) => s.id);
    const cards = sectors.map((s) =>
      sectorCard(s, days.get(s.id), date, shiftIds),
    );
    return {
      date,
      today,
      shifts,
      inProgress: date === today ? overnightInProgress(shifts, now) : null,
      sectors: cards.sort((a, b) => byName.compare(a.name, b.name)),
    };
  }
}
