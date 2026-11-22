import { Injectable } from '@nestjs/common';
import type { TeamWhatsappRecipientStatus } from '@prisma/client';
import type {
  TeamDispatchChannels,
  TeamDispatchCounts,
  TeamDispatchDetail,
  TeamDispatchRecipientPage,
  TeamRosterPerson,
} from '../../schemas/contracts/team-whatsapp.schema';
import { nameView } from '../../shared/authz/phone-visibility';
import type { DispatchRecipientsQuery } from './dto/dispatch-recipients-query.dto';
import { dispatchNotFound, teamForbidden } from './team-whatsapp.errors';
import {
  authorView,
  sectorRank,
  seesFullPhone,
  sortByViewedName,
} from './team-whatsapp.name-view';
import { isRepeatable } from './team-whatsapp.outcome';
import {
  canViewDispatch,
  isTeamSender,
  type TeamActor,
} from './team-whatsapp.policy';
import {
  TeamWhatsappRepository,
  type DispatchRecipientRow,
  type TeamChannelCount,
  type TeamStatusCount,
} from './team-whatsapp.repository';
import { parseRosterSnapshot, rosterGroups } from './team-whatsapp.roster';

const STATUS_KEY: Record<
  TeamWhatsappRecipientStatus,
  keyof TeamDispatchCounts
> = {
  QUEUED: 'queued',
  SENT: 'sent',
  DELIVERED: 'delivered',
  READ: 'read',
  REPLIED: 'replied',
  FAILED: 'failed',
  UNCERTAIN: 'uncertain',
  SKIPPED: 'skipped',
  SCHEDULED: 'scheduled',
  CANCELLED: 'cancelled',
};

export const zeroCounts = (): TeamDispatchCounts => ({
  queued: 0,
  sent: 0,
  delivered: 0,
  read: 0,
  replied: 0,
  failed: 0,
  uncertain: 0,
  skipped: 0,
  scheduled: 0,
  cancelled: 0,
});

/** Contagens por situação de cada envio (as 10 chaves, com zeros). */
export function countsByDispatch(
  rows: readonly TeamStatusCount[],
): Map<string, TeamDispatchCounts> {
  const byDispatch = new Map<string, TeamDispatchCounts>();
  for (const row of rows) {
    const counts = byDispatch.get(row.dispatchId) ?? zeroCounts();
    counts[STATUS_KEY[row.status]] += row.count;
    byDispatch.set(row.dispatchId, counts);
  }
  return byDispatch;
}

/** Números de cada envio, na ordem do repositório (maior primeiro). */
export function channelsByDispatch(
  rows: readonly TeamChannelCount[],
): Map<string, TeamDispatchChannels> {
  const byDispatch = new Map<string, TeamDispatchChannels>();
  for (const { dispatchId, ...channel } of rows) {
    byDispatch.set(dispatchId, [
      ...(byDispatch.get(dispatchId) ?? []),
      channel,
    ]);
  }
  return byDispatch;
}

/** Foto anterior à T7/T8b não tem setor nem nível da pessoa → null (C6). */
function withSnapshot(p: TeamRosterPerson) {
  return {
    ...p,
    sectorName: p.sectorName ?? null,
    levelName: p.levelName ?? null,
  };
}

/**
 * Pessoa da foto no detalhe, com o nome pela regra da chave. A foto lista um
 * setor por vez na ordem do nome real; sem a chave, cada setor passa a sair
 * pelo nome exibido (o gravado não muda).
 */
function viewedPeople(people: readonly TeamRosterPerson[], full: boolean) {
  const viewed = people.map((p) => ({
    ...withSnapshot(p),
    name: nameView(p.name, { full }),
  }));
  const rank = sectorRank(viewed, full);
  return sortByViewedName(viewed, full, (p) => ({
    group: rank(p),
    name: p.name,
    id: p.userId ?? shownKey(p),
  }));
}

/**
 * Desempate da foto antiga, sem `userId`: só o que o leitor já vê (o setor já
 * é o `group`), nunca o nome real.
 */
const shownKey = (p: {
  jobTitle: string | null;
  shiftName: string | null;
  levelName: string | null;
  reason: string | null;
}): string => [p.jobTitle, p.shiftName, p.levelName, p.reason].join('\u0000');

const iso = (date: Date | null) => date?.toISOString() ?? null;

function toRecipientItem(
  r: DispatchRecipientRow,
  full: boolean,
): TeamDispatchRecipientPage['items'][number] {
  return {
    id: r.id,
    userName: nameView(r.userName, { full }),
    sectorName: r.sectorName,
    levelName: r.levelName,
    shiftName: r.shiftName,
    status: r.status,
    reason: r.skipReason ?? r.errorCode,
    attempts: r.attempts,
    channel: r.channel,
    acceptedAt: iso(r.acceptedAt),
    // Um DELIVERED que chega depois de READ não grava deliveredAt (T10).
    deliveredAt: iso(r.deliveredAt ?? r.readAt),
    readAt: iso(r.readAt),
    repliedAt: iso(r.repliedAt),
    repeatable: isRepeatable(r.status, r.errorCode),
  };
}

/**
 * Tela de resultado de um envio (C5): detalhe e destinatários paginados. A
 * visibilidade (GC5) é decidida antes de qualquer dado do envio: remetente
 * (403) e depois `canViewDispatch`; envio alheio é 404, igual ao inexistente.
 */
@Injectable()
export class TeamWhatsappResultsService {
  constructor(private readonly repo: TeamWhatsappRepository) {}

  async detail(
    actorId: string,
    dispatchId: string,
  ): Promise<TeamDispatchDetail> {
    const full = seesFullPhone(await this.requireVisible(actorId, dispatchId));
    const row = await this.repo.findDispatchDetail(dispatchId);
    if (!row) throw dispatchNotFound();
    const ids = [dispatchId];
    const [statuses, channels, leftOut] = await Promise.all([
      this.repo.countByStatus(ids),
      this.repo.channelsByDispatch(ids),
      this.leftOut(dispatchId, row.roster, full),
    ]);
    return {
      id: row.id,
      targetLabel: nameView(row.targetLabel, { full }),
      text: row.text,
      state: row.state,
      createdAt: row.createdAt.toISOString(),
      scheduledFor: iso(row.scheduledFor),
      firedAt: iso(row.firedAt),
      author: authorView(row.author, full),
      sectors: row.sectors
        .map((s) => ({ id: s.sectorId, name: s.sectorName }))
        .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR')),
      counts: countsByDispatch(statuses).get(dispatchId) ?? zeroCounts(),
      channels: channelsByDispatch(channels).get(dispatchId) ?? [],
      leftOut,
    };
  }

  async recipients(
    actorId: string,
    dispatchId: string,
    query: DispatchRecipientsQuery,
  ): Promise<TeamDispatchRecipientPage> {
    const actor = await this.requireVisible(actorId, dispatchId);
    const { rows, total } = await this.repo.listDispatchRecipients(
      dispatchId,
      query,
    );
    const full = seesFullPhone(actor);
    return {
      items: rows.map((r) => toRecipientItem(r, full)),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  /** Remetente (403) e depois visibilidade (404): quem não vê não descobre se o envio existe. */
  private async requireVisible(
    actorId: string,
    dispatchId: string,
  ): Promise<TeamActor> {
    const actor = await this.repo.findActor(actorId);
    if (!actor || !isTeamSender(actor)) throw teamForbidden();
    const dispatch = await this.repo.findDispatchForActor(dispatchId);
    if (!dispatch || !canViewDispatch(actor, dispatch)) {
      throw dispatchNotFound();
    }
    return actor;
  }

  /** Da foto da escala: escalados no filtro e de folga que não são destinatários. */
  private async leftOut(
    dispatchId: string,
    roster: unknown,
    full: boolean,
  ): Promise<TeamDispatchDetail['leftOut']> {
    const snapshot = parseRosterSnapshot(roster);
    const photoIds = snapshot
      ? [...snapshot.working, ...snapshot.off].flatMap((p) =>
          p.userId ? [p.userId] : [],
        )
      : [];
    const recipientIds = new Set(
      await this.repo.findRecipientUserIds(dispatchId, photoIds),
    );
    const { unselected, off } = rosterGroups(snapshot, recipientIds);
    return {
      unselected: viewedPeople(unselected, full),
      off: viewedPeople(off, full),
    };
  }
}
