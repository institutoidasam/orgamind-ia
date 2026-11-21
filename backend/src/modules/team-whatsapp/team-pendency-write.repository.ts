import type { Prisma, TeamPendencyNoteKind } from '@prisma/client';
import type {
  HandlerState,
  PendencySituation,
} from '../../schemas/contracts/team-pendency.schema';
import type { AuditChange } from '../../shared/audit/audit-change';
import type { AuditService } from '../../shared/audit/audit.service';
import type { PrismaService } from '../../shared/prisma/prisma.service';
import {
  pendencyConflict,
  pendencySituation,
  type LockedPendency,
  type PendencyConflict,
  type PendencyExpectation,
} from './team-pendency.rules';

/**
 * Núcleo de escrita da pendência (Lote K2, DK10): trava a linha do destinatário,
 * confere o estado que a tela mostrava e só então grava colunas, anotação e
 * trilha, tudo na mesma transação. Ninguém mais grava as colunas `pendency*` nem
 * `TeamPendencyNote` (GK3). O resultado é um valor, não uma exceção: o K3 usa o
 * conflito como motivo de pulo na passagem de turno.
 */

/** Prazos da transação interativa (DK22 do K1): o padrão do Prisma estoura sob espera de trava. */
export const PENDENCY_TX_OPTIONS = {
  timeout: 10_000,
  maxWait: 5_000,
} as const;

export type PendencyAuditAction =
  | 'team_whatsapp.pendency_assume'
  | 'team_whatsapp.pendency_transfer'
  | 'team_whatsapp.pendency_note'
  | 'team_whatsapp.pendency_close'
  | 'team_whatsapp.pendency_reopen'
  | 'team_whatsapp.pendency_handover';

/** Chave ausente = coluna mantida; `null` = coluna limpa. */
export type PendencyPatch = Partial<
  Pick<
    LockedPendency,
    | 'handlerId'
    | 'assignedAt'
    | 'dueAt'
    | 'closedAt'
    | 'closedById'
    | 'closeReason'
  >
>;

export type PendencyTransition = {
  recipientId: string;
  actorId: string;
  now: Date;
  action: PendencyAuditAction;
  /** `metadata.kind` da trilha. */
  kind?: string;
  expect: PendencyExpectation;
  /** null = colunas iguais (só anotação; com `note` nulo também, só conferência, DK10.4). */
  patch: PendencyPatch | null;
  note: { kind: TeamPendencyNoteKind; text: string } | null;
  /** Estado do responsável antes (lido antes da trava) e depois, para a situação da trilha (DK16). */
  handlerState: { before: HandlerState | null; after: HandlerState | null };
};

export type PendencySnapshot = {
  handlerId: string | null;
  situation: PendencySituation;
  dueAt: string | null;
};

export type PendencyOutcome =
  | {
      ok: true;
      before: PendencySnapshot;
      after: PendencySnapshot;
      noteId: string | null;
    }
  | { ok: false; conflict: PendencyConflict; current: LockedPendency | null };

/** DK10.2: lê e trava a linha (`FOR NO KEY UPDATE`); ausente → null. */
export async function lockPendency(
  tx: Prisma.TransactionClient,
  id: string,
): Promise<LockedPendency | null> {
  const rows = await tx.$queryRaw<LockedPendency[]>`
    SELECT "id", "dispatchId", "ackAt",
      "pendencyHandlerId" AS "handlerId",
      "pendencyAssignedAt" AS "assignedAt",
      "pendencyDueAt" AS "dueAt",
      "pendencyClosedAt" AS "closedAt",
      "pendencyClosedById" AS "closedById",
      "pendencyCloseReason" AS "closeReason"
    FROM "TeamWhatsappRecipient" WHERE "id" = ${id} FOR NO KEY UPDATE`;
  return rows[0] ?? null;
}

const keep = <T>(next: T | undefined, current: T): T =>
  next === undefined ? current : next;

function nextColumns(
  locked: LockedPendency,
  patch: PendencyPatch | null,
): LockedPendency {
  if (patch === null) return locked;
  return {
    ...locked,
    handlerId: keep(patch.handlerId, locked.handlerId),
    assignedAt: keep(patch.assignedAt, locked.assignedAt),
    dueAt: keep(patch.dueAt, locked.dueAt),
    closedAt: keep(patch.closedAt, locked.closedAt),
    closedById: keep(patch.closedById, locked.closedById),
    closeReason: keep(patch.closeReason, locked.closeReason),
  };
}

function snapshotOf(
  state: LockedPendency,
  handlerState: HandlerState | null,
  now: Date,
): PendencySnapshot {
  return {
    handlerId: state.handlerId,
    situation: pendencySituation(
      {
        ackAt: state.ackAt,
        closedAt: state.closedAt,
        handlerId: state.handlerId,
        handlerState,
        dueAt: state.dueAt,
      },
      now,
    ),
    dueAt: state.dueAt?.toISOString() ?? null,
  };
}

/**
 * `UPDATE` cru das seis colunas, sem `updatedAt`: `[status, updatedAt]` é o índice
 * do verificador de envios presos, e a ação de pendência não pode adiar a
 * reconciliação de um envio preso (o `update` do Prisma tocaria o `@updatedAt`).
 */
async function writeColumns(
  tx: Prisma.TransactionClient,
  id: string,
  next: LockedPendency,
): Promise<void> {
  await tx.$executeRaw`
    UPDATE "TeamWhatsappRecipient" SET
      "pendencyHandlerId" = ${next.handlerId},
      "pendencyAssignedAt" = ${next.assignedAt},
      "pendencyDueAt" = ${next.dueAt},
      "pendencyClosedAt" = ${next.closedAt},
      "pendencyClosedById" = ${next.closedById},
      "pendencyCloseReason" = ${next.closeReason}
    WHERE "id" = ${id}`;
}

/** DK16: ids, situações e datas; nunca o texto da anotação, o motivo, nome nem telefone. */
function trailOf(
  t: PendencyTransition,
  recorded: {
    dispatchId: string;
    before: PendencySnapshot;
    after: PendencySnapshot;
    noteId: string | null;
  },
): AuditChange {
  const { dispatchId, before, after, noteId } = recorded;
  return {
    action: t.action,
    entity: 'TeamWhatsappRecipient',
    entityId: t.recipientId,
    category: null,
    changes: [
      { field: 'handlerId', before: before.handlerId, after: after.handlerId },
      { field: 'situation', before: before.situation, after: after.situation },
      { field: 'dueAt', before: before.dueAt, after: after.dueAt },
    ],
    metadata: {
      dispatchId,
      recipientId: t.recipientId,
      ...(t.kind === undefined ? {} : { kind: t.kind }),
      ...(noteId === null ? {} : { noteId }),
    },
    actorId: t.actorId,
  };
}

async function insertNote(
  tx: Prisma.TransactionClient,
  t: PendencyTransition,
  note: NonNullable<PendencyTransition['note']>,
): Promise<string> {
  const created = await tx.teamPendencyNote.create({
    data: {
      recipientId: t.recipientId,
      kind: note.kind,
      authorId: t.actorId,
      text: note.text,
      createdAt: t.now,
    },
    select: { id: true },
  });
  return created.id;
}

/** DK10.4–6: linha já travada e conferida; grava colunas, anotação e trilha no mesmo `tx`. */
async function applyTransition(
  tx: Prisma.TransactionClient,
  audit: AuditService,
  t: PendencyTransition,
  locked: LockedPendency,
): Promise<PendencyOutcome> {
  const before = snapshotOf(locked, t.handlerState.before, t.now);
  if (t.patch === null && t.note === null) {
    return { ok: true, before, after: before, noteId: null };
  }
  const next = nextColumns(locked, t.patch);
  if (t.patch !== null) await writeColumns(tx, locked.id, next);
  const noteId = t.note ? await insertNote(tx, t, t.note) : null;
  const after = snapshotOf(next, t.handlerState.after, t.now);
  const dispatchId = locked.dispatchId;
  await audit.recordChange(
    tx,
    trailOf(t, { dispatchId, before, after, noteId }),
  );
  return { ok: true, before, after, noteId };
}

/**
 * DK10: transação única (trava, conferência pura por `pendencyConflict`, escrita,
 * anotação e trilha). Conflito ou pendência ausente devolve `{ ok: false }` sem
 * gravar nada; erro de gravação ou da trilha propaga e desfaz tudo.
 */
export function runPendencyTransition(
  prisma: PrismaService,
  audit: AuditService,
  t: PendencyTransition,
): Promise<PendencyOutcome> {
  return prisma.$transaction(async (tx): Promise<PendencyOutcome> => {
    const locked = await lockPendency(tx, t.recipientId);
    if (locked === null) {
      return { ok: false, conflict: 'missing', current: null };
    }
    const conflict = pendencyConflict(locked, t.expect);
    if (conflict !== null) return { ok: false, conflict, current: locked };
    return applyTransition(tx, audit, t, locked);
  }, PENDENCY_TX_OPTIONS);
}
