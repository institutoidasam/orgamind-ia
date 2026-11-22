import type { PrismaService } from '../../shared/prisma/prisma.service';
import { finishSkipped } from './team-recipient-finish';

/**
 * Ciência do destinatário original do alerta (I7, DI11): leitura nova de
 * `ackAt`, feita na hora de mandar o lembrete (não vale o que o job carregou
 * antes do pacing). Original que sumiu não prova ciência: o lembrete segue.
 */
export async function parentAcked(
  prisma: Pick<PrismaService, 'teamWhatsappRecipient'>,
  parentRecipientId: string,
): Promise<boolean> {
  const parent = await prisma.teamWhatsappRecipient.findUnique({
    where: { id: parentRecipientId },
    select: { ackAt: true },
  });
  return parent?.ackAt != null;
}

/**
 * "Pulado: já confirmou" (I7): o lembrete cujo original já tem ciência não sai.
 * `true` = o processor para aqui, sem porta ao vivo nem provedor; o pulo é o
 * `finishSkipped` do H (DH3), que cancela a `Message` `QUEUED` preparada e só
 * muda o destinatário se ele ainda está `QUEUED`. Destinatário que não é de
 * lembrete (sem `parentRecipientId`) não paga leitura nenhuma. Só ids no
 * caminho: nenhum dado pessoal.
 */
export async function skipWhenParentAcked(
  prisma: Pick<PrismaService, 'teamWhatsappRecipient' | '$transaction'>,
  r: { id: string; messageId: string | null; parentRecipientId: string | null },
): Promise<boolean> {
  if (!r.parentRecipientId) return false;
  if (!(await parentAcked(prisma, r.parentRecipientId))) return false;
  await finishSkipped(prisma, {
    recipientId: r.id,
    messageId: r.messageId,
    skipReason: 'ACKED',
  });
  return true;
}
