import { describe, expect, it, vi } from 'vitest';
import { actorWith } from '../../shared/authz/actor.test-fixtures';
import { TeamAlertReminderService } from './team-alert-reminder.service';

// T9-m1 (I7, DI10): a troca condicional de `reminderCount`/`lastReminderAt` na
// transação do lembrete. O pedido que perde a corrida acha `count 0` no
// `updateMany` e termina em 409 `reminder_too_soon`, sem criar o lembrete, sem
// enfileirar e sem trilha. A corrida real fica no spec de integração do T9.
const CREATED_AT = new Date('2026-11-20T13:00:00.000Z');
const NOW = new Date(CREATED_AT.getTime() + 10 * 60_000);

/** Um alerta de 15 min com uma pessoa que recebeu e não respondeu. */
function fakeDb(swap: { count: number }) {
  const person = {
    id: 'r1',
    userId: 'u1',
    userName: 'Pessoa 1',
    status: 'SENT',
    sectorId: 's1',
    sectorName: 'Logística',
    ackAt: null,
    lastReplyMessageId: null,
    reminderRecipients: [],
  };
  const db = {
    teamWhatsappDispatch: {
      findUnique: vi.fn().mockResolvedValue({
        id: 'a1',
        createdAt: CREATED_AT,
        ackDeadlineMinutes: 15,
        reminderCount: 0,
        lastReminderAt: null,
      }),
      updateMany: vi.fn().mockResolvedValue(swap),
      findUniqueOrThrow: vi.fn(),
      create: vi.fn(),
    },
    teamWhatsappDispatchSector: { createMany: vi.fn() },
    teamWhatsappRecipient: {
      findMany: vi.fn().mockResolvedValue([person]),
      createManyAndReturn: vi.fn(),
    },
    user: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: 'u1',
          phoneE164: '+5592991110001',
          contact: null,
          contactAuthorization: 'AUTORIZADO',
        },
      ]),
    },
    $transaction: vi.fn((run: (tx: unknown) => unknown) => run(db)),
  };
  return db;
}

/** Remetente com a chave, que gere o setor do alerta, e o número do setor. */
function fakeRepo() {
  const actor = {
    ...actorWith('SUPERVISOR', { id: 'sup-1', grant: ['equipe.urgencia'] }),
    managedSectorIds: ['s1'],
  };
  return {
    findActor: vi.fn().mockResolvedValue(actor),
    findDispatchForActor: vi.fn().mockResolvedValue({
      id: 'a1',
      authorId: 'sup-1',
      targetType: 'SECTOR',
      targetId: 's1',
      state: 'DISPATCHED',
      sectors: [{ sectorId: 's1' }],
    }),
    findSector: vi.fn().mockResolvedValue({ id: 's1', isActive: true }),
    findSectorChannels: vi
      .fn()
      .mockResolvedValue(
        new Map([['s1', { id: 'c1', name: 'Canal', phoneE164: null }]]),
      ),
  };
}

/** Porta ao vivo falsa: todo número aberto. */
const fakeLive = () => ({
  checkMany: vi.fn((chs: { id: string }[]) =>
    Promise.resolve(
      new Map(
        chs.map((c) => [
          c.id,
          { channelId: c.id, state: 'open', checkedAt: NOW },
        ]),
      ),
    ),
  ),
});

function setup(swap: { count: number }) {
  const db = fakeDb(swap);
  const queue = { addBulk: vi.fn() };
  const audit = { log: vi.fn() };
  const service = new TeamAlertReminderService(
    fakeRepo() as never,
    db as never,
    audit as never,
    queue as never,
  );
  const consent = { isSuppressed: vi.fn().mockResolvedValue(false) };
  Object.assign(service, { live: fakeLive(), consent });
  const send = () => service.send('sup-1', 'a1', { recipientIds: ['r1'] }, NOW);
  return { db, queue, audit, send };
}

describe('TeamAlertReminderService — troca condicional (T9-m1, DI10)', () => {
  it('count 0 na troca de reminderCount/lastReminderAt — 409 reminder_too_soon, sem lembrete, sem fila, sem trilha', async () => {
    const f = setup({ count: 0 });

    await expect(f.send()).rejects.toMatchObject({
      status: 409,
      code: 'team_whatsapp.reminder_too_soon',
    });

    // A troca vale só para o que foi lido: contador e hora do último lembrete.
    expect(f.db.teamWhatsappDispatch.updateMany).toHaveBeenCalledOnce();
    expect(f.db.teamWhatsappDispatch.updateMany).toHaveBeenCalledWith({
      where: { id: 'a1', reminderCount: 0, lastReminderAt: null },
      data: { reminderCount: { increment: 1 }, lastReminderAt: NOW },
    });
    expect(f.db.teamWhatsappDispatch.create).not.toHaveBeenCalled();
    expect(f.db.teamWhatsappDispatchSector.createMany).not.toHaveBeenCalled();
    expect(
      f.db.teamWhatsappRecipient.createManyAndReturn,
    ).not.toHaveBeenCalled();
    expect(f.queue.addBulk).not.toHaveBeenCalled();
    expect(f.audit.log).not.toHaveBeenCalled();
  });
});
