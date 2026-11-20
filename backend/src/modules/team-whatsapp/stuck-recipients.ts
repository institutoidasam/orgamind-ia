import type { MessageStatus, Prisma } from '@prisma/client';

/**
 * Verificador de presos (spec H2): destinatário `QUEUED` parado há mais que
 * isto cujo job não está mais vivo na fila é classificado pela Message.
 */
export const STUCK_AFTER_MS = 30 * 60 * 1000;
export const STUCK_BATCH = 200;
/** Saiu da fila sem envio: repetível (fica fora de NOT_REPEATABLE_CODES). */
export const QUEUE_LOST_CODE = 'team_whatsapp.queue_lost';
/** A Message gravada sumiu: não repetível (está em NOT_REPEATABLE_CODES). */
export const MESSAGE_MISSING_CODE = 'team_whatsapp.message_missing';
/** Pode ter saído: "situação incerta", fora do "Repetir". */
export const STUCK_CODE = 'team_whatsapp.stuck';

export type StuckCandidate = {
  id: string;
  dispatchId: string;
  messageId: string | null;
  manualRetries: number;
};

/** `null` = a Message gravada no destinatário foi apagada. */
export type StuckMessage = {
  status: MessageStatus;
  errorCode: string | null;
  sentAt: Date | null;
} | null;

export type StuckOutcome =
  | { kind: 'queueLost'; cancelMessage: boolean }
  | { kind: 'missing' }
  | { kind: 'sent'; acceptedAt: Date }
  | { kind: 'failed'; errorCode: string }
  | { kind: 'uncertain' };

const ACCEPTED: ReadonlySet<MessageStatus> = new Set<MessageStatus>([
  'SENT',
  'DELIVERED',
  'READ',
]);

/** Limiar do `updatedAt` abaixo do qual o destinatário `QUEUED` conta como parado. */
export function stuckBefore(now: Date): Date {
  return new Date(now.getTime() - STUCK_AFTER_MS);
}

/**
 * Desfecho do preso (DH6), na mesma leitura do `priorOutcome` do processor.
 * `redispatchable` é o `ChatService.isRedispatchableFailure`, recebido como
 * função para este módulo não depender do chat. Nunca devolve "reenviar": o
 * verificador não põe nada de volta na fila (só o "Repetir" faz isso).
 */
export function stuckOutcome(input: {
  messageId: string | null;
  message: StuckMessage;
  now: Date;
  redispatchable: (code: string | null) => boolean;
}): StuckOutcome {
  const { messageId, message } = input;
  if (messageId === null) return { kind: 'queueLost', cancelMessage: false };
  if (message === null) return { kind: 'missing' };
  if (message.status === 'QUEUED')
    return { kind: 'queueLost', cancelMessage: true };
  if (ACCEPTED.has(message.status))
    return { kind: 'sent', acceptedAt: message.sentAt ?? input.now };
  if (
    message.status === 'FAILED' &&
    message.errorCode !== null &&
    input.redispatchable(message.errorCode)
  )
    return { kind: 'failed', errorCode: message.errorCode };
  // SENDING, FAILED não reenviável (timeout, unknown, sending_stuck, sem código),
  // CANCELLED, WAITING_INSTANCE, RECEIVED, SKIPPED_*: pode ter saído.
  return { kind: 'uncertain' };
}

/** O que a troca grava no destinatário em cada desfecho. */
export function recipientDataOf(
  outcome: StuckOutcome,
): Prisma.TeamWhatsappRecipientUpdateManyMutationInput {
  switch (outcome.kind) {
    case 'queueLost':
      return { status: 'FAILED', errorCode: QUEUE_LOST_CODE };
    case 'missing':
      return { status: 'FAILED', errorCode: MESSAGE_MISSING_CODE };
    case 'sent':
      return { status: 'SENT', acceptedAt: outcome.acceptedAt };
    case 'failed':
      return { status: 'FAILED', errorCode: outcome.errorCode };
    case 'uncertain':
      return { status: 'UNCERTAIN', errorCode: STUCK_CODE };
  }
}
