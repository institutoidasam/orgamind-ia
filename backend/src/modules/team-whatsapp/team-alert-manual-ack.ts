import { Prisma, type TeamAlertAckKind } from '@prisma/client';

/**
 * Gravações da ciência manual (CI6, DI7). Recebem o client ou a transação.
 * Cada uma decide sozinha, numa única gravação condicional, contra a ciência
 * automática (`recordAlertReply`, DI6) que pode chegar ao mesmo tempo.
 */
export type ManualAckDb = Pick<
  Prisma.TransactionClient,
  'teamWhatsappRecipient' | '$queryRaw'
>;

type RecipientRef = { dispatchId: string; recipientId: string };

/** O destinatário é deste envio (destinatário de lembrete na rota do alerta não é). */
export async function isRecipientOf(
  db: Pick<ManualAckDb, 'teamWhatsappRecipient'>,
  ref: RecipientRef,
): Promise<boolean> {
  const row = await db.teamWhatsappRecipient.findFirst({
    where: { id: ref.recipientId, dispatchId: ref.dispatchId },
    select: { id: true },
  });
  return row !== null;
}

/**
 * Marca a ciência manual só se ainda não há nenhuma (I4): a manual não
 * sobrescreve a automática e vice-versa. `false` = já tinha ciência
 * (`ack_exists`). `ackMessageId`/`lastReplyMessageId` não são tocados.
 */
export async function markManualAck(
  db: Pick<ManualAckDb, 'teamWhatsappRecipient'>,
  i: RecipientRef & { actorId: string; note: string; now: Date },
): Promise<boolean> {
  const { count } = await db.teamWhatsappRecipient.updateMany({
    where: { id: i.recipientId, dispatchId: i.dispatchId, ackAt: null },
    data: {
      ackAt: i.now,
      ackKind: 'MANUAL',
      ackByUserId: i.actorId,
      ackNote: i.note,
    },
  });
  return count === 1;
}

/**
 * Desfaz a ciência manual num único `UPDATE` condicional a `ackKind = MANUAL`
 * (DI7). O próprio `UPDATE` decide pelo `ackMessageAt` da linha no instante da
 * gravação: com um "OK" já gravado (DI6 (b)), a ciência vira automática com a
 * hora dele; senão, volta à pendência. Não lê a `Message` (apagada em cascata
 * com a conversa, um "OK" real voltaria à pendência). Numa corrida com o
 * `recordAlertReply`, o Postgres reavalia o `WHERE` e o `SET` sobre a versão
 * mais nova da linha. `ackMessageId`, `ackMessageAt` e `lastReplyMessageId`
 * nunca são apagados. `null` = não era manual (`ack_not_manual`).
 */
export async function undoManualAck(
  db: Pick<ManualAckDb, '$queryRaw'>,
  i: RecipientRef,
): Promise<'pending' | 'keyword' | null> {
  const rows = await db.$queryRaw<{ ackKind: TeamAlertAckKind | null }[]>(
    Prisma.sql`
      UPDATE "TeamWhatsappRecipient"
      SET "ackAt" = "ackMessageAt",
          "ackKind" = CASE WHEN "ackMessageAt" IS NOT NULL
                           THEN 'KEYWORD'::"TeamAlertAckKind"
                           ELSE NULL END,
          "ackByUserId" = NULL,
          "ackNote" = NULL,
          "updatedAt" = now()
      WHERE "id" = ${i.recipientId}
        AND "dispatchId" = ${i.dispatchId}
        AND "ackKind" = 'MANUAL'
      RETURNING "ackKind"`,
  );
  const [row] = rows;
  if (!row) return null;
  return row.ackKind === 'KEYWORD' ? 'keyword' : 'pending';
}
