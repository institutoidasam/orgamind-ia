import { describe, expect, it, vi } from 'vitest';
import { finishSkipped } from './team-recipient-finish';

type Counts = { message: number; recipient: number };
type Write = { where: unknown; data: unknown };

/**
 * `$transaction` interativa falsa: registra a ordem das gravações e se a
 * transação confirmou ou foi desfeita (callback que lança = rollback).
 */
function fakePrisma(counts: Counts) {
  const log: string[] = [];
  const tx = {
    message: {
      updateMany: vi.fn<(a: Write) => Promise<{ count: number }>>(() => {
        log.push('message');
        return Promise.resolve({ count: counts.message });
      }),
    },
    teamWhatsappRecipient: {
      updateMany: vi.fn<(a: Write) => Promise<{ count: number }>>(() => {
        log.push('recipient');
        return Promise.resolve({ count: counts.recipient });
      }),
    },
  };
  const $transaction = vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => {
    log.push('begin');
    try {
      const out = await fn(tx);
      log.push('commit');
      return out;
    } catch (err) {
      log.push('rollback');
      throw err;
    }
  });
  return { prisma: { $transaction } as never, tx, log };
}

const INPUT = {
  recipientId: 'r1',
  messageId: 'm1',
  skipReason: 'PHONE_CHANGED' as const,
};

describe('finishSkipped — ordem das gravações', () => {
  it('cancela a Message QUEUED antes de pular o destinatário, na mesma transação', async () => {
    const { prisma, tx, log } = fakePrisma({ message: 1, recipient: 1 });
    await expect(finishSkipped(prisma, INPUT)).resolves.toEqual({
      skipped: true,
      messageCancelled: true,
    });
    expect(log).toEqual(['begin', 'message', 'recipient', 'commit']);
    expect(tx.message.updateMany.mock.calls).toEqual([
      [
        {
          where: { id: 'm1', status: 'QUEUED' },
          data: { status: 'CANCELLED' },
        },
      ],
    ]);
    expect(tx.teamWhatsappRecipient.updateMany.mock.calls).toEqual([
      [
        {
          where: { id: 'r1', status: 'QUEUED' },
          data: {
            status: 'SKIPPED',
            skipReason: 'PHONE_CHANGED',
            channelCheckedAt: null,
          },
        },
      ],
    ]);
  });
});

describe('finishSkipped — linha ou Message fora de QUEUED', () => {
  it('linha que já não está QUEUED: a transação se desfaz e a Message não é cancelada', async () => {
    const { prisma, log } = fakePrisma({ message: 1, recipient: 0 });
    await expect(finishSkipped(prisma, INPUT)).resolves.toEqual({
      skipped: false,
      messageCancelled: false,
    });
    expect(log).toEqual(['begin', 'message', 'recipient', 'rollback']);
  });

  it('Message que já não está QUEUED (count 0): o destinatário ainda é pulado', async () => {
    const { prisma, log } = fakePrisma({ message: 0, recipient: 1 });
    await expect(finishSkipped(prisma, INPUT)).resolves.toEqual({
      skipped: true,
      messageCancelled: false,
    });
    expect(log).toEqual(['begin', 'message', 'recipient', 'commit']);
  });

  it('sem messageId: só o pulo', async () => {
    const { prisma, tx, log } = fakePrisma({ message: 1, recipient: 1 });
    await expect(
      finishSkipped(prisma, {
        ...INPUT,
        messageId: null,
        skipReason: 'NO_PHONE',
      }),
    ).resolves.toEqual({ skipped: true, messageCancelled: false });
    expect(log).toEqual(['begin', 'recipient', 'commit']);
    expect(tx.message.updateMany).not.toHaveBeenCalled();
  });

  it('erro de banco que não é o sentinela sobe intacto', async () => {
    const { prisma, tx } = fakePrisma({ message: 1, recipient: 1 });
    tx.teamWhatsappRecipient.updateMany.mockRejectedValueOnce(
      new Error('db down'),
    );
    await expect(finishSkipped(prisma, INPUT)).rejects.toThrow('db down');
  });
});
