import { Injectable } from '@nestjs/common';
import type {
  PendencyHandlersResponse,
  PendencyListQuery,
  PendencySituation,
  TeamPendencyCount,
  TeamPendencyItem,
  TeamPendencyList,
} from '../../schemas/contracts/team-pendency.schema';
import { nameView } from '../../shared/authz/phone-visibility';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { findTeamActor } from './team-actor.query';
import {
  handlerStatesFor,
  listHandlerCandidates,
  type HandlerStateView,
} from './team-actors.query';
import { loadAlertMessages, loadUserNames } from './team-alert.repository';
import { pendencyNotFound } from './team-pendency.errors';
import {
  loadConversationIds,
  loadOpenPendencyBatch,
  loadPendencyDetails,
  loadPendencyLightRows,
  pendencyFactsOf,
  type PendencyDetail,
  type PendencyLightRow,
} from './team-pendency.query';
import {
  pendencyScopeWhere,
  requireVisiblePendency,
} from './team-pendency-scope.repository';
import {
  PENDENCY_LIST_MAX_ROWS,
  canHandlePendency,
  comparePendencies,
  effectiveSectorId,
  isUnassignedOverdue,
  pendencyScopeOf,
  pendencySituation,
  type SortablePendency,
} from './team-pendency.rules';
import {
  buildPendencyItem,
  seesInbox,
  viewNeedsOf,
  type PendencyViewContext,
} from './team-pendency.view';
import { teamForbidden } from './team-whatsapp.errors';
import { seesFullPhone, sortByViewedName } from './team-whatsapp.name-view';
import { isTeamSender, type TeamActor } from './team-whatsapp.policy';

const DAY_MS = 86_400_000;
const collator = new Intl.Collator('pt-BR');

/** Linha leve com o estado do responsável e a situação já calculados (DK5). */
type RankedRow = {
  row: PendencyLightRow;
  handler: HandlerStateView | null;
  situation: PendencySituation;
};

function rankRows(
  rows: readonly PendencyLightRow[],
  handlers: ReadonlyArray<HandlerStateView | null>,
  now: Date,
): RankedRow[] {
  return rows.map((row, i) => {
    const handler = handlers[i];
    const situation = pendencySituation(
      {
        ackAt: row.ackAt,
        closedAt: row.closedAt,
        handlerId: row.handlerId,
        handlerState: handler?.state ?? null,
        dueAt: row.dueAt,
      },
      now,
    );
    return { row, handler, situation };
  });
}

const sortableOf = ({ row, situation }: RankedRow): SortablePendency => ({
  id: row.id,
  situation,
  alertCreatedAt: row.alertCreatedAt,
  ackDeadlineAt: row.ackDeadlineAt,
});

/**
 * Filtros da tela (K2-5): situação, setor EFETIVO (inclusive o nominal) e
 * "Minhas"; e o responsável gravado (`handlerId`, K3-4), mesmo o inativo ou
 * fora do alcance. Roda depois do alcance, sobre as linhas já lidas.
 */
function matchesFilters(
  ranked: RankedRow,
  query: PendencyListQuery,
  actorId: string,
): boolean {
  if (!query.situations.includes(ranked.situation)) return false;
  const { row } = ranked;
  if (
    query.sectorId !== undefined &&
    effectiveSectorId(row) !== query.sectorId
  ) {
    return false;
  }
  if (query.handlerId !== undefined && row.handlerId !== query.handlerId) {
    return false;
  }
  return query.mine !== 'true' || row.handlerId === actorId;
}

/** Setores efetivos das linhas lidas, antes de qualquer filtro (DK7, passo 5), por nome. */
function sectorsOf(
  rows: readonly PendencyLightRow[],
): TeamPendencyList['sectors'] {
  const byId = new Map<string, string>();
  for (const row of rows) {
    const id = effectiveSectorId(row);
    if (id !== null && row.sectorName !== null && !byId.has(id)) {
      byId.set(id, row.sectorName);
    }
  }
  return [...byId]
    .map(([id, name]) => ({ id, name }))
    .sort(
      (a, b) =>
        collator.compare(a.name, b.name) || collator.compare(a.id, b.id),
    );
}

/** Contexto da montagem: lê só o que `viewNeedsOf` pede, em paralelo (DK7, passo 4). */
async function viewContextFor(
  prisma: PrismaService,
  base: { actor: TeamActor; now: Date },
  details: readonly PendencyDetail[],
): Promise<PendencyViewContext> {
  const needs = viewNeedsOf(details);
  const [replies, conversations, names] = await Promise.all([
    loadAlertMessages(prisma, needs.replyIds),
    seesInbox(base.actor)
      ? loadConversationIds(prisma, needs.messageIds)
      : Promise.resolve(new Map<string, string | null>()),
    loadUserNames(prisma, needs.userIds),
  ]);
  return { ...base, replies, conversations, names };
}

/**
 * Leituras das pendências da equipe (K2-5, DK7–DK9): lista, item, contador e
 * destinos. O alcance (K2-4) vale em todas; o ator é relido do banco a cada
 * chamada.
 */
@Injectable()
export class TeamPendencyService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Remetente (403) → alcance → leitura com teto → situação, filtros e ordem em
   * memória → página → detalhes só da página. `maxRows` é o teto por consulta
   * (padrão `PENDENCY_LIST_MAX_ROWS`), parâmetro só para o teste "acima do teto".
   */
  async list(
    actorId: string,
    query: PendencyListQuery,
    now: Date,
    maxRows: number = PENDENCY_LIST_MAX_ROWS,
  ): Promise<TeamPendencyList> {
    const actor = await findTeamActor(this.prisma, actorId);
    if (actor === null || !isTeamSender(actor)) throw teamForbidden();
    const scope = pendencyScopeWhere(pendencyScopeOf(actor));
    const empty = { items: [], total: 0, sectors: [], truncated: false };
    const page = { page: query.page, pageSize: query.pageSize };
    if (scope === null) return { ...empty, ...page };
    const read = await loadPendencyLightRows(this.prisma, {
      scope,
      situations: query.situations,
      since: new Date(now.getTime() - query.days * DAY_MS),
      max: maxRows,
    });
    const handlers = await handlerStatesFor(this.prisma, read.rows);
    const shown = rankRows(read.rows, handlers, now)
      .filter((ranked) => matchesFilters(ranked, query, actor.id))
      .sort((a, b) => comparePendencies(sortableOf(a), sortableOf(b), now));
    const start = (query.page - 1) * query.pageSize;
    const pageRows = shown.slice(start, start + query.pageSize);
    const items = await this.itemsOf(actor, pageRows, now);
    return {
      items,
      total: shown.length,
      sectors: sectorsOf(read.rows),
      truncated: read.truncated,
      ...page,
    };
  }

  /** Remetente (403) → existe e está no alcance (404) → detalhe do item. */
  async get(actorId: string, id: string, now: Date): Promise<TeamPendencyItem> {
    const { actor } = await requireVisiblePendency(this.prisma, actorId, id);
    const detail = (await loadPendencyDetails(this.prisma, [id])).get(id);
    if (detail === undefined) throw pendencyNotFound();
    const [handler] = await handlerStatesFor(this.prisma, [
      pendencyFactsOf(detail),
    ]);
    const [item] = await this.buildItems(actor, [{ detail, handler }], now);
    return item;
  }

  /**
   * Contador do menu (K2-6, DK7): Sem responsável com o prazo de ciência
   * vencido, no alcance, sem limite de data e SEM teto nem `truncated`. O banco
   * filtra alcance e abertas; cada lote (por cursor de `id`) calcula o
   * responsável e a situação em memória, como a lista, e soma. `batchSize`
   * (padrão `PENDENCY_LIST_MAX_ROWS`) é parâmetro só para o teste "acima do teto".
   */
  async count(
    actorId: string,
    now: Date,
    batchSize: number = PENDENCY_LIST_MAX_ROWS,
  ): Promise<TeamPendencyCount> {
    const actor = await findTeamActor(this.prisma, actorId);
    if (actor === null || !isTeamSender(actor)) throw teamForbidden();
    const scope = pendencyScopeWhere(pendencyScopeOf(actor));
    if (scope === null) return { unassignedOverdue: 0 };
    const size = Math.max(1, batchSize);
    let unassignedOverdue = 0;
    let afterId: string | null = null;
    for (;;) {
      const rows = await loadOpenPendencyBatch(this.prisma, {
        scope,
        batchSize: size,
        afterId,
      });
      const handlers = await handlerStatesFor(this.prisma, rows);
      unassignedOverdue += rankRows(rows, handlers, now).filter((ranked) =>
        isUnassignedOverdue(sortableOf(ranked), now),
      ).length;
      if (rows.length < size) return { unassignedOverdue };
      afterId = rows[rows.length - 1].id;
    }
  }

  /**
   * Destinos de "Transferir" (K2-7): quem pode tratar ESTA pendência
   * (`canHandlePendency`: remetente ativo, com acesso, com `equipe.enviar`, que a
   * vê), só id e nome. Não tira o responsável atual nem quem pergunta: o front
   * esconde o atual do menu e o servidor trata "para o mesmo" como nada a fazer.
   */
  async handlers(
    actorId: string,
    id: string,
  ): Promise<PendencyHandlersResponse> {
    const { actor, facts } = await requireVisiblePendency(
      this.prisma,
      actorId,
      id,
    );
    const full = seesFullPhone(actor);
    const items = (await listHandlerCandidates(this.prisma))
      .filter((candidate) => canHandlePendency(candidate, facts))
      .map((candidate) => ({
        id: candidate.id,
        name: nameView(candidate.name, { full }),
      }));
    return {
      items: sortByViewedName(items, full, (item) => ({ group: 0, ...item })),
    };
  }

  private async itemsOf(
    actor: TeamActor,
    pageRows: readonly RankedRow[],
    now: Date,
  ): Promise<TeamPendencyItem[]> {
    const details = await loadPendencyDetails(
      this.prisma,
      pageRows.map(({ row }) => row.id),
    );
    const entries = pageRows.flatMap(({ row, handler }) => {
      const detail = details.get(row.id);
      return detail === undefined ? [] : [{ detail, handler }];
    });
    return this.buildItems(actor, entries, now);
  }

  private async buildItems(
    actor: TeamActor,
    entries: ReadonlyArray<{
      detail: PendencyDetail;
      handler: HandlerStateView | null;
    }>,
    now: Date,
  ): Promise<TeamPendencyItem[]> {
    const ctx = await viewContextFor(
      this.prisma,
      { actor, now },
      entries.map((entry) => entry.detail),
    );
    return entries.map(({ detail, handler }) =>
      buildPendencyItem(detail, handler, ctx),
    );
  }
}
