import type {
  MessageKind,
  Prisma,
  TeamAlertAckKind,
  TeamWhatsappRecipientStatus,
} from '@prisma/client';
import { notAnAlert } from './team-alert.errors';
import type { AlertPersonFacts } from './team-alert.rules';
import { dispatchNotFound } from './team-whatsapp.errors';

/**
 * Leituras do alerta urgente (CI5, Lote I). Recebem o client ou a transação:
 * o painel (T7), a ciência manual (T6) e o lembrete (T9, também com o `tx`)
 * leem o cabeçalho e as pessoas por aqui, sem releitura própria.
 */
export type AlertDb = Pick<
  Prisma.TransactionClient,
  'teamWhatsappRecipient' | 'teamWhatsappDispatch'
>;

/** Cabeçalho do alerta; `DispatchForActor` não traz estes campos. */
export type AlertHeader = {
  id: string;
  createdAt: Date;
  ackDeadlineMinutes: number;
  reminderCount: number;
  lastReminderAt: Date | null;
};

/**
 * Única leitura do cabeçalho do alerta. Linha ausente → o 404 de hoje; sem
 * `ackDeadlineMinutes` (outra finalidade, urgência antiga, lembrete) → 422
 * `not_an_alert` (I8).
 */
export async function loadAlertHeader(
  db: AlertDb,
  dispatchId: string,
): Promise<AlertHeader> {
  const row = await db.teamWhatsappDispatch.findUnique({
    where: { id: dispatchId },
    select: {
      id: true,
      createdAt: true,
      ackDeadlineMinutes: true,
      reminderCount: true,
      lastReminderAt: true,
    },
  });
  if (!row) throw dispatchNotFound();
  const { ackDeadlineMinutes } = row;
  if (ackDeadlineMinutes === null) throw notAnAlert();
  return { ...row, ackDeadlineMinutes };
}

const alertPersonSelect = {
  id: true,
  userId: true,
  userName: true,
  status: true,
  sectorId: true,
  sectorName: true,
  shiftId: true,
  shiftName: true,
  levelName: true,
  ackAt: true,
  ackKind: true,
  ackByUserId: true,
  ackNote: true,
  ackMessageId: true,
  lastReplyMessageId: true,
  reminderRecipients: {
    select: { status: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  },
} satisfies Prisma.TeamWhatsappRecipientSelect;

/** Destinatário do alerta original com os estados dos destinatários de lembrete dele. */
export type AlertPersonRow = {
  id: string;
  userId: string | null;
  userName: string;
  status: TeamWhatsappRecipientStatus;
  sectorId: string | null;
  sectorName: string | null;
  shiftId: string | null;
  shiftName: string | null;
  levelName: string | null;
  ackAt: Date | null;
  ackKind: TeamAlertAckKind | null;
  ackByUserId: string | null;
  ackNote: string | null;
  ackMessageId: string | null;
  lastReplyMessageId: string | null;
  reminderStatuses: TeamWhatsappRecipientStatus[];
};

/** Pessoas do alerta: os destinatários dele, cada um com os estados dos lembretes (`parentRecipientId`). */
export async function loadAlertPeople(
  db: AlertDb,
  alertId: string,
): Promise<AlertPersonRow[]> {
  const rows = await db.teamWhatsappRecipient.findMany({
    where: { dispatchId: alertId },
    select: alertPersonSelect,
    orderBy: { id: 'asc' },
  });
  return rows.map(({ reminderRecipients, ...row }) => ({
    ...row,
    reminderStatuses: reminderRecipients.map((r) => r.status),
  }));
}

/** Fatos das regras puras (DI8): estado do original primeiro, depois os dos lembretes. */
export function factsOf(row: AlertPersonRow): AlertPersonFacts {
  return {
    ackAt: row.ackAt,
    lastReplyMessageId: row.lastReplyMessageId,
    statuses: [row.status, ...row.reminderStatuses],
  };
}

/** Mensagem recebida ligada ao alerta; `at` = `receivedAt ?? createdAt`. */
export type AlertReplyMessage = {
  content: string | null;
  kind: MessageKind;
  at: Date;
};

/** Mensagens por id; a apagada (cascata da conversa) simplesmente não vem. */
export async function loadAlertMessages(
  db: Pick<Prisma.TransactionClient, 'message'>,
  ids: readonly string[],
): Promise<Map<string, AlertReplyMessage>> {
  if (ids.length === 0) return new Map();
  const rows = await db.message.findMany({
    where: { id: { in: [...new Set(ids)] } },
    select: {
      id: true,
      content: true,
      kind: true,
      receivedAt: true,
      createdAt: true,
    },
  });
  return new Map(
    rows.map((m) => [
      m.id,
      { content: m.content, kind: m.kind, at: m.receivedAt ?? m.createdAt },
    ]),
  );
}

/** Lembrete do alerta, de qualquer autor (I7), com quantos destinatários teve. */
export type AlertReminderRow = {
  id: string;
  createdAt: Date;
  authorId: string | null;
  recipients: number;
};

export async function loadAlertReminders(
  db: AlertDb,
  alertId: string,
): Promise<AlertReminderRow[]> {
  const rows = await db.teamWhatsappDispatch.findMany({
    where: { parentDispatchId: alertId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      createdAt: true,
      authorId: true,
      _count: { select: { recipients: true } },
    },
  });
  return rows.map(({ _count, ...row }) => ({
    ...row,
    recipients: _count.recipients,
  }));
}

/** Nomes reais de usuários com login (autor da ciência manual e dos lembretes), num `findMany` só. */
export async function loadUserNames(
  db: Pick<Prisma.TransactionClient, 'user'>,
  ids: readonly string[],
): Promise<Map<string, string | null>> {
  if (ids.length === 0) return new Map();
  const rows = await db.user.findMany({
    where: { id: { in: [...new Set(ids)] } },
    select: { id: true, name: true },
  });
  return new Map(rows.map((u) => [u.id, u.name]));
}
