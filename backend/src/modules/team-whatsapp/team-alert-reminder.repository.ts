import type { Prisma, TeamWhatsappRecipientStatus } from '@prisma/client';
import type { PrismaService } from '../../shared/prisma/prisma.service';
import type { PhoneSkipReason } from './recipient-skip';
import {
  reminderEmpty,
  reminderLimit,
  reminderTooSoon,
} from './team-alert.errors';
import {
  factsOf,
  loadAlertHeader,
  loadAlertPeople,
  type AlertHeader,
  type AlertPersonRow,
} from './team-alert.repository';
import {
  reminderBlock,
  reminderEligibility,
  reminderText,
} from './team-alert.rules';
import { recipientChannelIds, singleChannelId } from './team-whatsapp.channels';
import { noRecipients } from './team-whatsapp.errors';

/** Transação do lembrete (DI10): o padrão de 5 s do Prisma não basta para 500 destinatários. */
export const REMINDER_TX_TIMEOUT_MS = 15_000;

/**
 * Pessoas do lembrete e as recusas, na ordem de I7: elegíveis (DI8) ∩ pedidos
 * vazia → 422 `reminder_empty`; 3 lembretes → 409 `reminder_limit`; menos de
 * 5 min do alerta ou do último lembrete → 409 `reminder_too_soon`. A mesma
 * função na pré-checagem e na transação: a lista só encolhe, nunca ganha
 * alguém de fora do alerta.
 */
export function chooseReminderPeople(
  header: AlertHeader,
  people: readonly AlertPersonRow[],
  requested: ReadonlySet<string>,
  now: Date,
): AlertPersonRow[] {
  const chosen = people.filter(
    (p) => requested.has(p.id) && reminderEligibility(factsOf(p)).eligible,
  );
  if (chosen.length === 0) throw reminderEmpty();
  const block = reminderBlock({
    reminderCount: header.reminderCount,
    lastReminderAt: header.lastReminderAt,
    alertCreatedAt: header.createdAt,
    now,
  });
  if (block === 'reminder_limit') throw reminderLimit();
  if (block === 'reminder_too_soon') throw reminderTooSoon();
  return chosen;
}

const phoneOwnerSelect = {
  id: true,
  phoneE164: true,
  contact: { select: { phoneE164: true } },
  contactAuthorization: true,
} satisfies Prisma.UserSelect;

/** Os campos que `sendPhoneOf` e `phoneSkipReason` leem (os de `teamMemberSelect`). */
export type PhoneOwner = Prisma.UserGetPayload<{
  select: typeof phoneOwnerSelect;
}>;

/**
 * Telefone atual de cada pessoa (DG7): a mesma leitura do envio "agora", do
 * cadastro de hoje, nunca o telefone gravado no alerta. Usuário apagado não
 * vem (o lembrete o pula como `NO_PHONE`, como o processor).
 */
export async function loadPhoneOwners(
  db: Pick<Prisma.TransactionClient, 'user'>,
  userIds: readonly string[],
): Promise<Map<string, PhoneOwner>> {
  if (userIds.length === 0) return new Map();
  const rows = await db.user.findMany({
    where: { id: { in: [...new Set(userIds)] } },
    select: phoneOwnerSelect,
  });
  return new Map(rows.map((u) => [u.id, u]));
}

/** Destinatário do lembrete montado antes da transação, com o telefone e o número de agora. */
export type ReminderDraft = {
  parentRecipientId: string;
  userId: string | null;
  userName: string;
  shiftId: string | null;
  shiftName: string | null;
  sectorId: string | null;
  sectorName: string | null;
  levelName: string | null;
  channelId: string;
  channelName: string;
  channelPhoneE164: string | null;
  phoneE164: string | null;
  status: 'QUEUED' | 'SKIPPED';
  skipReason: PhoneSkipReason | null;
};

export type ReminderPlan = {
  alertId: string;
  authorId: string;
  now: Date;
  /** Por destinatário do alerta (`parentRecipientId`): só os escolhidos na pré-checagem. */
  drafts: ReadonlyMap<string, ReminderDraft>;
};

export type WrittenReminder = {
  reminderId: string;
  recipients: { id: string; status: TeamWhatsappRecipientStatus }[];
};

/**
 * Gravação do lembrete (I7, DI10), numa transação com prazo explícito: relê o
 * cabeçalho e as pessoas, refaz as três recusas, troca `reminderCount` e
 * `lastReminderAt` só se ainda valem o que foi lido e cria o envio. Recusa
 * aqui desfaz tudo: pedido vazio ou recusado não consome lembrete. Nada de
 * provedor nem fila aqui dentro.
 */
export function writeReminder(
  prisma: Pick<PrismaService, '$transaction'>,
  plan: ReminderPlan,
): Promise<WrittenReminder> {
  return prisma.$transaction((tx) => writeInTx(tx, plan), {
    timeout: REMINDER_TX_TIMEOUT_MS,
  });
}

async function writeInTx(
  tx: Prisma.TransactionClient,
  plan: ReminderPlan,
): Promise<WrittenReminder> {
  const header = await loadAlertHeader(tx, plan.alertId);
  const people = await loadAlertPeople(tx, plan.alertId);
  const requested = new Set(plan.drafts.keys());
  const chosen = chooseReminderPeople(header, people, requested, plan.now);
  const recipients = chosen.flatMap((p) => plan.drafts.get(p.id) ?? []);
  if (!recipients.some((r) => r.status === 'QUEUED')) throw noRecipients();
  // Pedido único: o segundo pedido simultâneo espera a linha e o Postgres
  // reavalia o WHERE sobre a versão nova; `count 0` = outro lembrete venceu.
  const { count } = await tx.teamWhatsappDispatch.updateMany({
    where: {
      id: plan.alertId,
      reminderCount: header.reminderCount,
      lastReminderAt: header.lastReminderAt,
    },
    data: { reminderCount: { increment: 1 }, lastReminderAt: plan.now },
  });
  if (count === 0) throw reminderTooSoon();
  const reminderId = await createReminderDispatch(tx, plan, recipients);
  const rows = await tx.teamWhatsappRecipient.createManyAndReturn({
    data: recipients.map((r) => ({ ...r, dispatchId: reminderId })),
    select: { id: true, status: true },
  });
  return { reminderId, recipients: rows };
}

const reminderSourceSelect = {
  targetType: true,
  targetId: true,
  targetLabel: true,
  shiftId: true,
  shiftName: true,
  shiftStartTime: true,
  shiftEndTime: true,
  rosterDate: true,
  audienceBase: true,
  urgencyReason: true,
  text: true,
  sectors: { select: { sectorId: true, sectorName: true } },
} satisfies Prisma.TeamWhatsappDispatchSelect;

/**
 * Envio do lembrete (I7): Urgência, o mesmo motivo, alvo, turno, data da
 * escala e linhas de setor do alerta (o "Repetir" do lembrete passa pela mesma
 * checagem de área); sem prazo, regra, foto nem excluídos; texto `Lembrete: `
 * + o texto gravado do alerta. Gravações planas: `create` e `createMany`.
 */
async function createReminderDispatch(
  tx: Prisma.TransactionClient,
  plan: ReminderPlan,
  recipients: readonly ReminderDraft[],
): Promise<string> {
  const { sectors, text, ...alert } =
    await tx.teamWhatsappDispatch.findUniqueOrThrow({
      where: { id: plan.alertId },
      select: reminderSourceSelect,
    });
  const { id } = await tx.teamWhatsappDispatch.create({
    data: {
      ...alert,
      authorId: plan.authorId,
      purpose: 'URGENCY',
      includeOff: false,
      channelId: singleChannelId(recipientChannelIds(recipients)),
      text: reminderText(text),
      parentDispatchId: plan.alertId,
      ackDeadlineMinutes: null,
      createdAt: plan.now,
    },
    select: { id: true },
  });
  await tx.teamWhatsappDispatchSector.createMany({
    data: sectors.map((s) => ({ ...s, dispatchId: id })),
  });
  return id;
}
