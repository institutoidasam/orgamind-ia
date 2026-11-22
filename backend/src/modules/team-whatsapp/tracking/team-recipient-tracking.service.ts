import { Injectable } from '@nestjs/common';
import type {
  MessageKind,
  Prisma,
  TeamWhatsappRecipientStatus,
} from '@prisma/client';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { isAckWord } from '../team-alert.rules';
import { alertOriginalOf, recordAlertReply } from './team-alert-reply';

type ReceiptStatus = 'DELIVERED' | 'READ';

// C4: QUEUED < SENT < DELIVERED < READ < REPLIED. O recibo só sobe: sai dos
// estados abaixo dele (UNCERTAIN sobe com recibo) e nunca toca nos terminais
// (FAILED, SKIPPED, CANCELLED) nem em quem já chegou mais longe.
const RECEIPT_FROM: Record<ReceiptStatus, TeamWhatsappRecipientStatus[]> = {
  DELIVERED: ['QUEUED', 'SENT', 'UNCERTAIN'],
  READ: ['QUEUED', 'SENT', 'DELIVERED', 'UNCERTAIN'],
};

// Resposta casa só com envio que o WhatsApp aceitou.
const REPLY_CANDIDATES: TeamWhatsappRecipientStatus[] = [
  'SENT',
  'DELIVERED',
  'READ',
  'REPLIED',
];
const REPLY_FROM: TeamWhatsappRecipientStatus[] = ['SENT', 'DELIVERED', 'READ'];

/** Mensagem recebida que a ingestão do chat gravou (CI4); o texto nunca vai a log. */
type ReplyMessage = { id: string; kind: MessageKind; text: string | null };

type LatestReply = {
  id: string;
  status: TeamWhatsappRecipientStatus;
  acceptedAt: Date | null;
  parentRecipientId: string | null;
  dispatch: {
    ackDeadlineMinutes: number | null;
    parentDispatchId: string | null;
  };
};

/**
 * Rastreio do destinatário do envio da equipe (D10): leva os recibos da
 * Message ("entregue", "lido") e a resposta da pessoa ao destinatário. Só
 * Prisma, para o webhook e a ingestão do chat o usarem sem ciclo de módulos.
 *
 * Toda transição é um `updateMany` condicional ao estado de origem, sem
 * ler-depois-gravar: eventos repetidos, fora de ordem ou concorrentes não
 * fazem o estado voltar.
 */
@Injectable()
export class TeamRecipientTrackingService {
  constructor(private readonly prisma: PrismaService) {}

  /** Devolve quantos destinatários mudaram (0 = recibo repetido, atrasado ou sem destinatário). */
  async applyReceipt(input: {
    messageId: string;
    status: ReceiptStatus;
    occurredAt: Date;
  }): Promise<number> {
    const { messageId, status, occurredAt } = input;
    const data: Prisma.TeamWhatsappRecipientUpdateManyMutationInput =
      status === 'DELIVERED'
        ? { status, deliveredAt: occurredAt }
        : { status, readAt: occurredAt };
    const where = { messageId, status: { in: RECEIPT_FROM[status] } };
    // R4: recibo que chega antes de o processor gravar o aceite também fixa
    // `acceptedAt`. Os dois updateMany são disjuntos (acceptedAt nulo ou não) e
    // o segundo já não casa com a linha que o primeiro subiu.
    const early = await this.prisma.teamWhatsappRecipient.updateMany({
      where: { ...where, acceptedAt: null },
      data: { ...data, acceptedAt: occurredAt },
    });
    const accepted = await this.prisma.teamWhatsappRecipient.updateMany({
      where: { ...where, acceptedAt: { not: null } },
      data,
    });
    return early.count + accepted.count;
  }

  /**
   * D11: a mensagem recebida marca só o destinatário mais recente daquele
   * número com `acceptedAt < receivedAt`. Já `REPLIED` → o estado não muda, e a
   * segunda mensagem não desce para um envio mais antigo. Devolve o id marcado.
   *
   * DI6 (Lote I): com `message`, a resposta também é ligada ao alerta (ou ao
   * alerta do lembrete) mesmo quando o mais recente já está `REPLIED`; a
   * palavra de ciência grava a ciência automática no destinatário original.
   */
  async applyReply(input: {
    channelId: string;
    contactIds: readonly string[];
    receivedAt: Date;
    message?: ReplyMessage;
  }): Promise<string | null> {
    const { channelId, contactIds, receivedAt, message } = input;
    if (contactIds.length === 0) return null;
    const latest: LatestReply | null =
      await this.prisma.teamWhatsappRecipient.findFirst({
        where: {
          channelId,
          contactId: { in: [...contactIds] },
          acceptedAt: { lt: receivedAt },
          status: { in: REPLY_CANDIDATES },
        },
        orderBy: [{ acceptedAt: 'desc' }, { id: 'desc' }],
        select: {
          id: true,
          status: true,
          acceptedAt: true,
          parentRecipientId: true,
          dispatch: {
            select: { ackDeadlineMinutes: true, parentDispatchId: true },
          },
        },
      });
    if (!latest) return null;
    const marked = await this.markReplied(latest, receivedAt);
    if (message) await this.linkAlertReply(latest, message, receivedAt);
    return marked;
  }

  /** Estado de entrega: só quem ainda não está `REPLIED` muda. */
  private async markReplied(
    latest: LatestReply,
    receivedAt: Date,
  ): Promise<string | null> {
    if (latest.status === 'REPLIED') return null;
    const marked = await this.prisma.teamWhatsappRecipient.updateMany({
      where: { id: latest.id, status: { in: REPLY_FROM } },
      data: { status: 'REPLIED', repliedAt: receivedAt },
    });
    return marked.count > 0 ? latest.id : null;
  }

  /** DI6: resposta ao alerta (ou ao lembrete) em até 24 h do aceite do mais recente. */
  private async linkAlertReply(
    latest: LatestReply,
    message: ReplyMessage,
    receivedAt: Date,
  ): Promise<void> {
    const { acceptedAt } = latest;
    if (acceptedAt === null) return;
    const originalId = alertOriginalOf({ ...latest, acceptedAt }, receivedAt);
    if (originalId === null) return;
    await recordAlertReply(this.prisma, {
      originalId,
      messageId: message.id,
      receivedAt,
      isAck: isAckWord(message),
    });
  }
}
