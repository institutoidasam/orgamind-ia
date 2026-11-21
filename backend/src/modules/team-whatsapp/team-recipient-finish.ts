import type { PrismaService } from '../../shared/prisma/prisma.service';

/** Motivo do pulo decidido pelo processor (`ACKED`: lembrete cujo original já confirmou, I7). */
export type SkipReasonOf =
  'NO_PHONE' | 'PHONE_CHANGED' | 'SUPPRESSED' | 'NOT_AUTHORIZED' | 'ACKED';

export type FinishSkippedInput = {
  recipientId: string;
  messageId: string | null;
  skipReason: SkipReasonOf;
};

export type FinishSkippedResult = {
  skipped: boolean;
  messageCancelled: boolean;
};

/** Sentinela: o destinatário já não estava QUEUED; lançado só para desfazer a transação. */
class RecipientNotQueuedError extends Error {
  override name = 'RecipientNotQueuedError';
}

const NOT_SKIPPED: FinishSkippedResult = {
  skipped: false,
  messageCancelled: false,
};

/**
 * Pulo do destinatário com a `Message` preparada por uma tentativa anterior
 * (H3, DH3), numa transação interativa e nesta ordem:
 *
 * 1. a `Message`, só se há `messageId`: `QUEUED → CANCELLED`, condicional. Só
 *    `QUEUED` prova que nada saiu e que ninguém a está mandando (o claim do chat
 *    é `QUEUED|FAILED → SENDING`); `FAILED`, `SENDING` ou qualquer outro estado
 *    não mudam (count 0), e isso não impede o pulo. Cancelar ANTES do
 *    destinatário fecha a janela em que uma execução paralela do mesmo job
 *    pegaria a `Message` entre as duas gravações.
 * 2. o destinatário: `QUEUED → SKIPPED` com o motivo e sem hora de conferência.
 *    Count 0 (outra execução ou um recibo já o fechou) desfaz a transação
 *    inteira: a `Message` volta a `QUEUED` e nada muda.
 *
 * Nenhum dado pessoal entra aqui (só ids e o motivo).
 */
export async function finishSkipped(
  prisma: Pick<PrismaService, '$transaction'>,
  input: FinishSkippedInput,
): Promise<FinishSkippedResult> {
  try {
    return await prisma.$transaction(async (tx) => {
      const messageCancelled = input.messageId
        ? (
            await tx.message.updateMany({
              where: { id: input.messageId, status: 'QUEUED' },
              data: { status: 'CANCELLED' },
            })
          ).count > 0
        : false;
      const { count } = await tx.teamWhatsappRecipient.updateMany({
        where: { id: input.recipientId, status: 'QUEUED' },
        data: {
          status: 'SKIPPED',
          skipReason: input.skipReason,
          channelCheckedAt: null,
        },
      });
      if (count === 0) throw new RecipientNotQueuedError();
      return { skipped: true, messageCancelled };
    });
  } catch (err) {
    if (err instanceof RecipientNotQueuedError) return NOT_SKIPPED;
    throw err;
  }
}
