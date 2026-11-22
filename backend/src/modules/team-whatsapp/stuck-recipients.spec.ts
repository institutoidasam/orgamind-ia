import { describe, expect, it } from 'vitest';
import type { MessageStatus } from '@prisma/client';
import { ChatService } from '../chat/chat.service';
import { isRepeatable } from './team-whatsapp.outcome';
import {
  MESSAGE_MISSING_CODE,
  QUEUE_LOST_CODE,
  STUCK_CODE,
  recipientDataOf,
  stuckOutcome,
  type StuckMessage,
} from './stuck-recipients';

// Regra REAL do ChatService.isRedispatchableFailure, sem dublê (o método não
// usa nenhuma dependência do serviço).
const chat = new ChatService(
  {} as never,
  {} as never,
  {} as never,
  {} as never,
  {} as never,
);
const redispatchable = (code: string | null) =>
  chat.isRedispatchableFailure(code);

const NOW = new Date('2026-11-20T12:00:00-04:00');
const SENT_AT = new Date('2026-11-20T11:10:00-04:00');

const msg = (
  status: MessageStatus,
  errorCode: string | null = null,
  sentAt: Date | null = null,
): StuckMessage => ({ status, errorCode, sentAt });

const outcomeOf = (message: StuckMessage, messageId: string | null = 'm1') =>
  stuckOutcome({ messageId, message, now: NOW, redispatchable });

describe('stuckOutcome — Message ausente ou ainda na fila', () => {
  it('sem messageId — queueLost sem cancelar Message', () => {
    expect(outcomeOf(null, null)).toEqual({
      kind: 'queueLost',
      cancelMessage: false,
    });
  });

  it('Message apagada — missing', () => {
    expect(outcomeOf(null)).toEqual({ kind: 'missing' });
  });

  it('Message QUEUED — queueLost cancelando a Message', () => {
    expect(outcomeOf(msg('QUEUED'))).toEqual({
      kind: 'queueLost',
      cancelMessage: true,
    });
  });
});

describe('stuckOutcome — Message que saiu da fila', () => {
  it('Message SENT, DELIVERED ou READ — sent com acceptedAt = sentAt; sem sentAt usa now', () => {
    for (const status of ['SENT', 'DELIVERED', 'READ'] as const) {
      expect(outcomeOf(msg(status, null, SENT_AT))).toEqual({
        kind: 'sent',
        acceptedAt: SENT_AT,
      });
    }
    expect(outcomeOf(msg('SENT'))).toEqual({ kind: 'sent', acceptedAt: NOW });
  });

  it('Message FAILED reenviável — failed com o código dela', () => {
    expect(outcomeOf(msg('FAILED', 'evolution.disconnected'))).toEqual({
      kind: 'failed',
      errorCode: 'evolution.disconnected',
    });
  });

  it('Message FAILED evolution.timeout, evolution.unknown, sending_stuck ou sem código — uncertain', () => {
    for (const code of [
      'evolution.timeout',
      'evolution.unknown',
      'sending_stuck',
      null,
    ]) {
      expect(outcomeOf(msg('FAILED', code))).toEqual({ kind: 'uncertain' });
    }
  });

  it('Message SENDING, CANCELLED ou WAITING_INSTANCE — uncertain', () => {
    for (const status of [
      'SENDING',
      'CANCELLED',
      'WAITING_INSTANCE',
    ] as const) {
      expect(outcomeOf(msg(status))).toEqual({ kind: 'uncertain' });
    }
  });
});

describe('recipientDataOf e o Repetir', () => {
  it('recipientDataOf de cada ramo', () => {
    const lost = { status: 'FAILED', errorCode: QUEUE_LOST_CODE };
    expect(recipientDataOf({ kind: 'queueLost', cancelMessage: true })).toEqual(
      lost,
    );
    expect(
      recipientDataOf({ kind: 'queueLost', cancelMessage: false }),
    ).toEqual(lost);
    expect(recipientDataOf({ kind: 'missing' })).toEqual({
      status: 'FAILED',
      errorCode: MESSAGE_MISSING_CODE,
    });
    expect(recipientDataOf({ kind: 'sent', acceptedAt: SENT_AT })).toEqual({
      status: 'SENT',
      acceptedAt: SENT_AT,
    });
    expect(
      recipientDataOf({ kind: 'failed', errorCode: 'evolution.disconnected' }),
    ).toEqual({
      status: 'FAILED',
      errorCode: 'evolution.disconnected',
    });
    expect(recipientDataOf({ kind: 'uncertain' })).toEqual({
      status: 'UNCERTAIN',
      errorCode: STUCK_CODE,
    });
  });

  it('queue_lost é repetível e message_missing não (isRepeatable)', () => {
    expect(isRepeatable('FAILED', QUEUE_LOST_CODE)).toBe(true);
    expect(isRepeatable('FAILED', MESSAGE_MISSING_CODE)).toBe(false);
    expect(isRepeatable('UNCERTAIN', STUCK_CODE)).toBe(false);
  });
});
