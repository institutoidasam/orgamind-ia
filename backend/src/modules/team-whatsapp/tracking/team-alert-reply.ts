import type { PrismaService } from '../../../shared/prisma/prisma.service';
import { withinReplyWindow } from '../team-alert.rules';

/** Destinatário mais recente que a resposta casou (busca do `applyReply`). */
export type AlertReplyTarget = {
  id: string;
  acceptedAt: Date;
  parentRecipientId: string | null;
  dispatch: {
    ackDeadlineMinutes: number | null;
    parentDispatchId: string | null;
  };
};

/**
 * DI6: a resposta conta para o alerta quando o destinatário mais recente é do
 * alerta (ele mesmo) ou de um lembrete (o destinatário original), e só até
 * 24 h do aceite desse mais recente. Resposta que não é posterior ao aceite
 * nunca conta (a busca do `applyReply` já filtra; aqui é a mesma regra).
 */
export function alertOriginalOf(
  latest: AlertReplyTarget,
  receivedAt: Date,
): string | null {
  if (receivedAt.getTime() <= latest.acceptedAt.getTime()) return null;
  if (!withinReplyWindow(latest.acceptedAt, receivedAt)) return null;
  if (latest.dispatch.parentDispatchId !== null)
    return latest.parentRecipientId;
  return latest.dispatch.ackDeadlineMinutes !== null ? latest.id : null;
}

/**
 * DI6: gravações no destinatário original, nesta ordem e separadas (sem
 * transação): (a) a última resposta; (b) a primeira mensagem com palavra de
 * ciência, com a hora dela; (c) a ciência, só se ainda não há nenhuma.
 *
 * (b) antes de (c) é obrigatório (aceite 22): o desfazer da ciência manual
 * devolve `ackAt` para `ackMessageAt`, então com (b) já gravado um desfazer
 * entre (b) e (c) resulta em ciência automática; com (c) primeiro, apagaria a
 * ciência e o "OK" ficaria sem efeito. Cada gravação é condicional à coluna
 * nula, então a manual gravada antes não muda. Se (a) falha, nada depois roda:
 * a pessoa fica pendente, nunca ciente. Nada aqui carrega o texto da resposta.
 */
export async function recordAlertReply(
  db: Pick<PrismaService, 'teamWhatsappRecipient'>,
  input: {
    originalId: string;
    messageId: string;
    receivedAt: Date;
    isAck: boolean;
  },
): Promise<void> {
  const { originalId: id, messageId, receivedAt, isAck } = input;
  const recipients = db.teamWhatsappRecipient;
  await recipients.updateMany({
    where: { id },
    data: { lastReplyMessageId: messageId },
  });
  if (!isAck) return;
  await recipients.updateMany({
    where: { id, ackMessageId: null },
    data: { ackMessageId: messageId, ackMessageAt: receivedAt },
  });
  await recipients.updateMany({
    where: { id, ackAt: null },
    data: { ackAt: receivedAt, ackKind: 'KEYWORD' },
  });
}
