import type { Prisma, TeamPendencyNoteKind } from '@prisma/client';
import type { PendencySituation } from '../../schemas/contracts/team-pendency.schema';
import { alertDeadlineAt } from './team-alert.rules';
import type { AlertPersonRow } from './team-alert.repository';
import type { PendencyScopeFacts } from './team-pendency.rules';

/**
 * Leituras da lista e do item de pendência (K2-5, DK7, DK8). A lista lê só os
 * fatos leves de todas as linhas do alcance (com teto) e os detalhes só da
 * página; nenhuma consulta daqui lê mensagem da conversa.
 */
export type PendencyReadDb = Pick<
  Prisma.TransactionClient,
  'teamWhatsappRecipient'
>;

/** Fatos leves de uma linha: o suficiente para situação, filtro, ordem e `sectors`. */
export type PendencyLightRow = PendencyScopeFacts & {
  id: string;
  handlerId: string | null;
  ackAt: Date | null;
  closedAt: Date | null;
  dueAt: Date | null;
  alertCreatedAt: Date;
  ackDeadlineAt: Date;
  /** Nome do setor efetivo: o gravado no envio ou, no nominal, o setor atual da pessoa. */
  sectorName: string | null;
};

const LIGHT_SELECT = {
  id: true,
  sectorId: true,
  sectorName: true,
  ackAt: true,
  pendencyHandlerId: true,
  pendencyDueAt: true,
  pendencyClosedAt: true,
  user: { select: { sectorId: true, sector: { select: { name: true } } } },
  dispatch: {
    select: { authorId: true, createdAt: true, ackDeadlineMinutes: true },
  },
} satisfies Prisma.TeamWhatsappRecipientSelect;

type LightRecord = Prisma.TeamWhatsappRecipientGetPayload<{
  select: typeof LIGHT_SELECT;
}>;

function toLightRow(r: LightRecord): PendencyLightRow {
  const minutes = r.dispatch.ackDeadlineMinutes;
  return {
    id: r.id,
    isAlert: minutes !== null,
    authorId: r.dispatch.authorId,
    sectorId: r.sectorId,
    personSectorId: r.user?.sectorId ?? null,
    sectorName:
      r.sectorId === null ? (r.user?.sector?.name ?? null) : r.sectorName,
    handlerId: r.pendencyHandlerId,
    ackAt: r.ackAt,
    closedAt: r.pendencyClosedAt,
    dueAt: r.pendencyDueAt,
    alertCreatedAt: r.dispatch.createdAt,
    ackDeadlineAt: alertDeadlineAt(r.dispatch.createdAt, minutes ?? 0),
  };
}

export type PendencyLightRead = {
  rows: PendencyLightRow[];
  truncated: boolean;
};

/**
 * Teto de segurança (DK7): lê da MAIS NOVA para a mais antiga (`createdAt desc`
 * do destinatário, que nasce com o envio) e pede `max + 1` para saber se
 * passou; o que fica de fora é o mais antigo. A ordem da lista é feita depois,
 * em memória, sobre o que foi lido.
 */
async function readCapped(
  db: PendencyReadDb,
  where: Prisma.TeamWhatsappRecipientWhereInput,
  max: number,
): Promise<PendencyLightRead> {
  const records = await db.teamWhatsappRecipient.findMany({
    where,
    select: LIGHT_SELECT,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: max + 1,
  });
  return {
    rows: records.slice(0, max).map(toLightRow),
    truncated: records.length > max,
  };
}

/** Abertas: sem ciência e sem encerramento, sem limite de data (K2-5). */
const OPEN_WHERE: Prisma.TeamWhatsappRecipientWhereInput = {
  ackAt: null,
  pendencyClosedAt: null,
};

/**
 * Cientes e encerradas dos últimos `days` dias, pela data do alerta; só o que
 * as situações pedidas mostram (a ciência vence o encerramento, DK5).
 */
function resolvedWhere(
  situations: readonly PendencySituation[],
  since: Date,
): Prisma.TeamWhatsappRecipientWhereInput | null {
  const kinds: Prisma.TeamWhatsappRecipientWhereInput[] = [];
  if (situations.includes('ACKED')) kinds.push({ ackAt: { not: null } });
  if (situations.includes('CLOSED')) {
    kinds.push({ ackAt: null, pendencyClosedAt: { not: null } });
  }
  if (kinds.length === 0) return null;
  return { OR: kinds, dispatch: { createdAt: { gte: since } } };
}

export type PendencyReadFilter = {
  /** `pendencyScopeWhere` do ator (nunca `null` aqui). */
  scope: Prisma.TeamWhatsappRecipientWhereInput;
  situations: readonly PendencySituation[];
  /** Início da janela de Ciente/Encerrada (data do alerta). */
  since: Date;
  /** Teto por consulta; `PENDENCY_LIST_MAX_ROWS` em produção. */
  max: number;
};

/** Passo 2 da lista (DK7): as abertas sempre; cientes e encerradas só se pedidas. */
export async function loadPendencyLightRows(
  db: PendencyReadDb,
  f: PendencyReadFilter,
): Promise<PendencyLightRead> {
  const open = await readCapped(db, { AND: [f.scope, OPEN_WHERE] }, f.max);
  const resolved = resolvedWhere(f.situations, f.since);
  if (resolved === null) return open;
  const closed = await readCapped(db, { AND: [f.scope, resolved] }, f.max);
  return {
    rows: [...open.rows, ...closed.rows],
    truncated: open.truncated || closed.truncated,
  };
}

export type PendencyBatchFilter = {
  /** `pendencyScopeWhere` do ator (nunca `null` aqui). */
  scope: Prisma.TeamWhatsappRecipientWhereInput;
  /** Linhas por lote (`PENDENCY_LIST_MAX_ROWS` em produção). */
  batchSize: number;
  /** Último `id` do lote anterior; `null` no primeiro. */
  afterId: string | null;
};

/**
 * Um lote do contador (DK7): as abertas do alcance (sem ciência e sem
 * encerramento, sem limite de data), por cursor de `id` crescente, só fatos
 * leves. O cursor é `id > afterId` (a mesma ordem do `cursor`/`skip: 1` do
 * Prisma): não depende de a linha do cursor ainda existir.
 */
export async function loadOpenPendencyBatch(
  db: PendencyReadDb,
  f: PendencyBatchFilter,
): Promise<PendencyLightRow[]> {
  const after = f.afterId === null ? [] : [{ id: { gt: f.afterId } }];
  const records = await db.teamWhatsappRecipient.findMany({
    where: { AND: [f.scope, OPEN_WHERE, ...after] },
    select: LIGHT_SELECT,
    orderBy: { id: 'asc' },
    take: f.batchSize,
  });
  return records.map(toLightRow);
}

export type PendencyNoteRow = {
  id: string;
  kind: TeamPendencyNoteKind;
  authorId: string;
  text: string;
  createdAt: Date;
};

/** Detalhe de uma linha da página: o que `AlertPersonRow` já traz mais a pendência, o envio e as anotações. */
export type PendencyDetail = AlertPersonRow & {
  dispatchId: string;
  phoneE164: string | null;
  messageId: string | null;
  personSectorId: string | null;
  handlerId: string | null;
  assignedAt: Date | null;
  dueAt: Date | null;
  closedAt: Date | null;
  closedById: string | null;
  closeReason: string | null;
  notes: PendencyNoteRow[];
  alert: {
    authorId: string | null;
    authorName: string | null;
    text: string;
    createdAt: Date;
    ackDeadlineMinutes: number | null;
  };
};

const DETAIL_SELECT = {
  id: true,
  dispatchId: true,
  userId: true,
  userName: true,
  status: true,
  sectorId: true,
  sectorName: true,
  shiftId: true,
  shiftName: true,
  levelName: true,
  phoneE164: true,
  messageId: true,
  ackAt: true,
  ackKind: true,
  ackByUserId: true,
  ackNote: true,
  ackMessageId: true,
  lastReplyMessageId: true,
  pendencyHandlerId: true,
  pendencyAssignedAt: true,
  pendencyDueAt: true,
  pendencyClosedAt: true,
  pendencyClosedById: true,
  pendencyCloseReason: true,
  reminderRecipients: {
    select: { status: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  },
  pendencyNotes: {
    select: {
      id: true,
      kind: true,
      authorId: true,
      text: true,
      createdAt: true,
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  },
  user: { select: { sectorId: true } },
  dispatch: {
    select: {
      authorId: true,
      createdAt: true,
      ackDeadlineMinutes: true,
      text: true,
      author: { select: { name: true } },
    },
  },
} satisfies Prisma.TeamWhatsappRecipientSelect;

type DetailRecord = Prisma.TeamWhatsappRecipientGetPayload<{
  select: typeof DETAIL_SELECT;
}>;

function toDetail(r: DetailRecord): PendencyDetail {
  const { dispatch, user, reminderRecipients, pendencyNotes, ...own } = r;
  return {
    id: own.id,
    dispatchId: own.dispatchId,
    userId: own.userId,
    userName: own.userName,
    status: own.status,
    sectorId: own.sectorId,
    sectorName: own.sectorName,
    shiftId: own.shiftId,
    shiftName: own.shiftName,
    levelName: own.levelName,
    phoneE164: own.phoneE164,
    messageId: own.messageId,
    ackAt: own.ackAt,
    ackKind: own.ackKind,
    ackByUserId: own.ackByUserId,
    ackNote: own.ackNote,
    ackMessageId: own.ackMessageId,
    lastReplyMessageId: own.lastReplyMessageId,
    reminderStatuses: reminderRecipients.map((s) => s.status),
    personSectorId: user?.sectorId ?? null,
    handlerId: own.pendencyHandlerId,
    assignedAt: own.pendencyAssignedAt,
    dueAt: own.pendencyDueAt,
    closedAt: own.pendencyClosedAt,
    closedById: own.pendencyClosedById,
    closeReason: own.pendencyCloseReason,
    notes: pendencyNotes,
    alert: {
      authorId: dispatch.authorId,
      authorName: dispatch.author?.name ?? null,
      text: dispatch.text,
      createdAt: dispatch.createdAt,
      ackDeadlineMinutes: dispatch.ackDeadlineMinutes,
    },
  };
}

/** Detalhes das linhas da página, por id; linha que sumiu entre as leituras fica fora do mapa. */
export async function loadPendencyDetails(
  db: PendencyReadDb,
  ids: readonly string[],
): Promise<Map<string, PendencyDetail>> {
  if (ids.length === 0) return new Map();
  const records = await db.teamWhatsappRecipient.findMany({
    where: { id: { in: [...ids] } },
    select: DETAIL_SELECT,
  });
  return new Map(records.map((r) => [r.id, toDetail(r)]));
}

/** Fatos do alcance de uma linha detalhada (o alerta é o envio com prazo de ciência). */
export function pendencyFactsOf(
  d: PendencyDetail,
): PendencyScopeFacts & { handlerId: string | null } {
  return {
    isAlert: d.alert.ackDeadlineMinutes !== null,
    authorId: d.alert.authorId,
    sectorId: d.sectorId,
    personSectorId: d.personSectorId,
    handlerId: d.handlerId,
  };
}

/**
 * Conversa da mensagem do ENVIO (não da resposta), só o id: nenhuma outra
 * mensagem nem texto da conversa é lido (Anti-objetivo 2).
 */
export async function loadConversationIds(
  db: Pick<Prisma.TransactionClient, 'message'>,
  messageIds: readonly string[],
): Promise<Map<string, string | null>> {
  if (messageIds.length === 0) return new Map();
  const rows = await db.message.findMany({
    where: { id: { in: [...new Set(messageIds)] } },
    select: { id: true, conversationId: true },
  });
  return new Map(rows.map((m) => [m.id, m.conversationId]));
}
