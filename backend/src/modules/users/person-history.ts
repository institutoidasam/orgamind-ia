import type { Prisma } from '@prisma/client';

type Client = Prisma.TransactionClient;
type Probe = (tx: Client, userId: string) => Promise<{ id: string } | null>;

const only = { id: true } as const;

/**
 * Onde a pessoa deixa histórico (A3/D7). Cada registro abaixo é apagado
 * (`Cascade`) ou perde o vínculo com a pessoa (`SetNull`) quando ela é
 * excluída; por isso quem aparece em qualquer um deles só pode ser inativado.
 * A consulta de cada um é um `findFirst` de uma linha.
 *
 * Ficam de fora, de propósito: autoria de segmento e de link de adesão,
 * canal sob responsabilidade da pessoa, gerência de setor e "convidado por"
 * (configuração e estado atual, não histórico da pessoa; o evento de
 * auditoria guarda o ator); leitura de comunicado (`InternalRead`, marcador de
 * caixa de entrada); e os eventos de comunicado que não são comentário (o
 * `actorSnapshot` guarda quem foi).
 */
const PROBES: readonly Probe[] = [
  (tx, userId) =>
    tx.teamWhatsappRecipient.findFirst({ where: { userId }, select: only }),
  (tx, userId) =>
    tx.teamWhatsappDispatch.findFirst({
      where: { authorId: userId },
      select: only,
    }),
  (tx, userId) =>
    tx.internalCommunication.findFirst({
      where: { OR: [{ authorId: userId }, { assigneeId: userId }] },
      select: only,
    }),
  (tx, userId) =>
    tx.internalEvent.findFirst({
      where: { actorId: userId, kind: 'COMMENTED' },
      select: only,
    }),
  (tx, userId) =>
    tx.conversation.findFirst({
      where: { assignedUserId: userId },
      select: only,
    }),
  (tx, userId) =>
    tx.staffSchedule.findFirst({ where: { userId }, select: only }),
  (tx, userId) =>
    tx.staffScheduleException.findFirst({ where: { userId }, select: only }),
];

/**
 * A pessoa tem histórico? Roda no `tx` do DELETE (serializable): conferir e
 * apagar acontecem na mesma transação, sem janela entre as duas. Sequencial,
 * porque o cliente da transação atende uma consulta por vez.
 */
export async function personHasHistory(
  tx: Client,
  userId: string,
): Promise<boolean> {
  for (const probe of PROBES) {
    if (await probe(tx, userId)) return true;
  }
  return false;
}
