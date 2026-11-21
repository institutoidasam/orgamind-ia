import { describe, expect, it } from 'vitest';
import {
  alertOriginalOf,
  recordAlertReply,
  type AlertReplyTarget,
} from './team-alert-reply';

const ACCEPTED = new Date('2026-11-10T12:00:00Z');
const HOUR_MS = 3_600_000;
const at = (hours: number) => new Date(ACCEPTED.getTime() + hours * HOUR_MS);

const target = (over: Partial<AlertReplyTarget> = {}): AlertReplyTarget => ({
  id: 'r-alert',
  acceptedAt: ACCEPTED,
  parentRecipientId: null,
  dispatch: { ackDeadlineMinutes: 15, parentDispatchId: null },
  ...over,
});

const REMINDER = target({
  id: 'r-reminder',
  parentRecipientId: 'r-alert',
  dispatch: { ackDeadlineMinutes: null, parentDispatchId: 'd-alert' },
});
const ROUTINE = target({
  id: 'r-routine',
  dispatch: { ackDeadlineMinutes: null, parentDispatchId: null },
});

type Write = { where: Record<string, unknown>; data: Record<string, unknown> };

/** Banco falso que só registra as gravações, na ordem em que chegam. */
function recordingDb() {
  const writes: Write[] = [];
  const db = {
    teamWhatsappRecipient: {
      updateMany: (args: Write) => {
        writes.push(args);
        return Promise.resolve({ count: 1 });
      },
    },
  };
  return { db: db as never, writes };
}

const RECEIVED = at(1);

describe('alertOriginalOf (DI6)', () => {
  it('destinatário do alerta → ele; do lembrete → parentRecipientId; de outro envio → null', () => {
    expect(alertOriginalOf(target(), RECEIVED)).toBe('r-alert');
    expect(alertOriginalOf(REMINDER, RECEIVED)).toBe('r-alert');
    expect(alertOriginalOf(ROUTINE, RECEIVED)).toBeNull();
  });

  it('fora de 24 h do aceite do mais recente → null', () => {
    expect(alertOriginalOf(target(), at(24))).toBe('r-alert');
    expect(
      alertOriginalOf(target(), new Date(at(24).getTime() + 1)),
    ).toBeNull();
    expect(alertOriginalOf(REMINDER, at(25))).toBeNull();
  });

  it('resposta que não é posterior ao aceite → null', () => {
    expect(alertOriginalOf(target(), ACCEPTED)).toBeNull();
    expect(alertOriginalOf(target(), at(-1))).toBeNull();
  });
});

describe('recordAlertReply (DI6)', () => {
  it('recordAlertReply grava lastReplyMessageId, depois ackMessageId, depois ackAt (ordem)', async () => {
    const { db, writes } = recordingDb();
    await recordAlertReply(db, {
      originalId: 'r-alert',
      messageId: 'msg-ok',
      receivedAt: RECEIVED,
      isAck: true,
    });
    expect(writes).toEqual([
      { where: { id: 'r-alert' }, data: { lastReplyMessageId: 'msg-ok' } },
      {
        where: { id: 'r-alert', ackMessageId: null },
        data: { ackMessageId: 'msg-ok', ackMessageAt: RECEIVED },
      },
      {
        where: { id: 'r-alert', ackAt: null },
        data: { ackAt: RECEIVED, ackKind: 'KEYWORD' },
      },
    ]);
  });

  it('sem palavra de ciência — só lastReplyMessageId', async () => {
    const { db, writes } = recordingDb();
    await recordAlertReply(db, {
      originalId: 'r-alert',
      messageId: 'msg-duvida',
      receivedAt: RECEIVED,
      isAck: false,
    });
    expect(writes).toEqual([
      { where: { id: 'r-alert' }, data: { lastReplyMessageId: 'msg-duvida' } },
    ]);
  });
});
