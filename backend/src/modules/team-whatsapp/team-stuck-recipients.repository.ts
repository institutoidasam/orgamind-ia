import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../shared/prisma/prisma.service';
import {
  QUEUE_LOST_CODE,
  STUCK_BATCH,
  recipientDataOf,
  stuckBefore,
  type StuckCandidate,
  type StuckMessage,
  type StuckOutcome,
} from './stuck-recipients';

/** A Message saiu de `QUEUED` entre a leitura e a troca: desfaz a transação inteira. */
class MessageLeftQueueError extends Error {
  constructor() {
    super('Stuck recipient message left QUEUED');
  }
}

/**
 * Leitura e troca do verificador de presos (CH4/DH7). Nunca põe nada de volta
 * na fila nem toca `attempts`, `manualRetries` ou `channelCheckedAt`: só o
 * "Repetir" (ação de quem envia) reenvia.
 */
@Injectable()
export class TeamStuckRecipientsRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** `QUEUED` parados desde antes de `now − STUCK_AFTER_MS`, mais antigos primeiro. */
  findCandidates(now: Date, limit = STUCK_BATCH): Promise<StuckCandidate[]> {
    return this.prisma.teamWhatsappRecipient.findMany({
      where: { status: 'QUEUED', updatedAt: { lt: stuckBefore(now) } },
      orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
      take: limit,
      select: {
        id: true,
        dispatchId: true,
        messageId: true,
        manualRetries: true,
      },
    });
  }

  loadMessage(messageId: string): Promise<StuckMessage> {
    return this.prisma.message.findUnique({
      where: { id: messageId },
      select: { status: true, errorCode: true, sentAt: true },
    });
  }

  /**
   * Troca condicional (DH7): só vale se o destinatário segue `QUEUED`, parado e
   * com os mesmos `messageId` e `manualRetries` lidos; um processor que termina,
   * um prepare que grava a Message ou um "Repetir" no meio ganham. `true` = trocou.
   */
  async settle(
    candidate: StuckCandidate,
    outcome: StuckOutcome,
    now: Date,
  ): Promise<boolean> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const moved = await tx.teamWhatsappRecipient.updateMany({
          where: {
            id: candidate.id,
            status: 'QUEUED',
            messageId: candidate.messageId,
            manualRetries: candidate.manualRetries,
            updatedAt: { lt: stuckBefore(now) },
          },
          data: { ...recipientDataOf(outcome), updatedAt: now },
        });
        if (moved.count === 0) return false;
        if (outcome.kind === 'queueLost' && outcome.cancelMessage)
          await cancelQueuedMessage(tx, candidate.messageId, now);
        return true;
      });
    } catch (err) {
      if (err instanceof MessageLeftQueueError) return false;
      throw err;
    }
  }
}

/**
 * A Message que ficou `QUEUED` vira `FAILED queue_lost` (reenviável: o "Repetir"
 * a reaproveita). Se ela já saiu de `QUEUED` (o chat a pegou), nada muda.
 */
async function cancelQueuedMessage(
  tx: Prisma.TransactionClient,
  messageId: string | null,
  now: Date,
): Promise<void> {
  if (messageId === null) throw new MessageLeftQueueError();
  const cancelled = await tx.message.updateMany({
    where: { id: messageId, status: 'QUEUED' },
    data: { status: 'FAILED', errorCode: QUEUE_LOST_CODE, failedAt: now },
  });
  if (cancelled.count === 0) throw new MessageLeftQueueError();
}
