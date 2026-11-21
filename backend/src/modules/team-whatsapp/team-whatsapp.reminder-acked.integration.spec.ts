import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DelayedError } from 'bullmq';
import type { User } from '@prisma/client';
import type * as PacingHelper from '../campaigns/pacing.helper';
import {
  buildT08World,
  T08_CHECKED_AT,
  type PacingRedis,
  type T08World,
} from './team-whatsapp.t08.test-fixtures';
import {
  startRecheckDeps,
  type RecheckDeps,
} from './team-whatsapp.schedule-recheck.test-fixtures';

// O pacing de verdade (lock no Redis falso do harness), sem o atraso anti-ban
// de 10 a 45 s: só o `sleepFn` injetável do `releasePacingLock` é trocado.
vi.mock('../campaigns/pacing.helper', async (importOriginal) => {
  const real = await importOriginal<typeof PacingHelper>();
  return {
    ...real,
    releasePacingLock: (
      ...[redis, id, logger]: Parameters<typeof real.releasePacingLock>
    ) => real.releasePacingLock(redis, id, logger, () => Promise.resolve()),
  };
});

// I7 / aceite 9 (parte "ainda na fila") contra Postgres real: o processor, a
// transação do pulo (H3), a "Repetir" e o ChatService são os de verdade; só a
// porta do provedor e a porta ao vivo são falsas. Nunca WhatsApp de verdade.
const ACK_AT = new Date('2026-11-20T15:10:00.000Z');
const DISCONNECTED = 'team_whatsapp.channel_disconnected';

let deps: RecheckDeps;
let stop: () => Promise<void>;

beforeAll(async () => {
  ({ deps, stop } = await startRecheckDeps());
}, 180_000);

afterAll(async () => {
  await stop?.();
});

type Ids = { alertId: string; reminderId: string };
type ReminderOver = {
  status?: 'FAILED';
  errorCode?: string;
  messageId?: string;
};

/** O alerta (com prazo) e o lembrete dele, no setor e no número do mundo. */
async function seedDispatches(w: T08World): Promise<Ids> {
  const base = {
    targetType: 'SECTOR',
    targetId: w.site.sectorId,
    targetLabel: w.site.sectorName,
    channelId: w.channelId,
    authorId: w.site.adminId,
    purpose: 'URGENCY',
    state: 'DISPATCHED',
    firedAt: T08_CHECKED_AT,
  } as const;
  const create = (data: {
    text: string;
    ackDeadlineMinutes?: number;
    parentDispatchId?: string;
  }) =>
    w.deps.prisma.teamWhatsappDispatch.create({ data: { ...base, ...data } });
  const alert = await create({ text: 'Alerta', ackDeadlineMinutes: 15 });
  const reminder = await create({
    text: 'Lembrete',
    parentDispatchId: alert.id,
  });
  return { alertId: alert.id, reminderId: reminder.id };
}

/**
 * O destinatário do alerta (já enviado; com ou sem ciência) e o do lembrete
 * ligado a ele (na fila, ou como `over` disser). Devolve o id do lembrete.
 */
async function addPair(
  w: T08World,
  ids: Ids,
  person: User,
  { ackAt, ...over }: { ackAt: Date | null } & ReminderOver,
): Promise<string> {
  const row = {
    userId: person.id,
    userName: person.name ?? '',
    phoneE164: person.phoneE164,
    channelId: w.channelId,
  };
  const { teamWhatsappRecipient: recipients } = w.deps.prisma;
  const original = await recipients.create({
    data: {
      ...row,
      dispatchId: ids.alertId,
      status: 'SENT',
      acceptedAt: T08_CHECKED_AT,
      ackAt,
      ackKind: ackAt ? 'KEYWORD' : null,
    },
  });
  const reminder = await recipients.create({
    data: {
      ...row,
      dispatchId: ids.reminderId,
      parentRecipientId: original.id,
      attempts: over.status ? 1 : 0,
      ...over,
    },
  });
  return reminder.id;
}

const enqueue = (w: T08World, ...recipientIds: string[]) =>
  w.queue.addBulk(
    recipientIds.map((id) => ({
      name: 'send',
      data: { recipientId: id },
      opts: { jobId: `${id}-i` },
    })),
  );

describe('I7 — lembrete que não sai a quem já confirmou (aceite 9)', () => {
  it('aceite 9: original ciente com o lembrete na fila — Pulado: já confirmou, sem chamada ao provedor', async () => {
    const w = await buildT08World(deps);
    const ids = await seedDispatches(w);
    const [ana, bia] = w.people;
    const acked = await addPair(w, ids, ana, { ackAt: ACK_AT });
    const pending = await addPair(w, ids, bia, { ackAt: null });
    await enqueue(w, acked, pending);

    await w.queue.drain(w.processor);

    const [skipped, sent] = await w.recipients(ids.reminderId);
    expect(skipped).toMatchObject({
      id: acked,
      status: 'SKIPPED',
      skipReason: 'ACKED',
      messageId: null,
      attempts: 0,
      channelCheckedAt: null,
    });
    // Quem ainda não confirmou recebe o lembrete, uma vez.
    expect(sent).toMatchObject({ id: pending, status: 'SENT', attempts: 1 });
    expect(w.provider.calls).toHaveLength(1);
    expect(w.provider.callsOf(sent.messageId ?? '')).toBe(1);
    expect(w.live.check).toHaveBeenCalledTimes(1);
    expect(await w.messages()).toHaveLength(1);
    // O lock do número sai com o pulo: nada ficou preso para o próximo.
    expect(w.pacing.held()).toEqual([]);
  }, 60_000);
});

describe('I7 — Message preparada do lembrete (aceite 9)', () => {
  it('Message do lembrete preparada por tentativa anterior — CANCELLED', async () => {
    const w = await buildT08World(deps);
    const ids = await seedDispatches(w);
    const { message } = w.deps.prisma;
    const prepared = await message.create({
      data: { instanceId: w.channelId, content: 'Lembrete' },
    });
    const id = await addPair(w, ids, w.people[0], {
      ackAt: ACK_AT,
      messageId: prepared.id,
    });
    await enqueue(w, id);

    await w.queue.drain(w.processor);

    const [row] = await w.recipients(ids.reminderId);
    expect(row).toMatchObject({
      id,
      status: 'SKIPPED',
      skipReason: 'ACKED',
      messageId: prepared.id,
    });
    expect(
      (await message.findUniqueOrThrow({ where: { id: prepared.id } })).status,
    ).toBe('CANCELLED');
    expect(w.provider.calls).toEqual([]);
    expect(w.live.check).not.toHaveBeenCalled();
  }, 60_000);
});

describe('I7 — "Repetir" do lembrete (aceite 9)', () => {
  it('Repetir do lembrete com o original ciente — pula também', async () => {
    const w = await buildT08World(deps);
    const ids = await seedDispatches(w);
    // O lembrete falhou antes de o original confirmar; a ciência veio depois.
    const id = await addPair(w, ids, w.people[0], {
      ackAt: ACK_AT,
      status: 'FAILED',
      errorCode: DISCONNECTED,
    });

    await expect(w.retryAll(ids.reminderId)).resolves.toEqual({ requeued: 1 });
    await w.queue.drain(w.processor);

    const [row] = await w.recipients(ids.reminderId);
    expect(row).toMatchObject({
      id,
      status: 'SKIPPED',
      skipReason: 'ACKED',
      manualRetries: 1,
    });
    expect(w.provider.calls).toEqual([]);
    expect(w.live.check).not.toHaveBeenCalled();
  }, 60_000);
});

/**
 * A 1ª tomada do lock do número fica parada logo depois de tomá-lo (o lock já
 * está gravado no Redis falso) e só segue em `open()`: a execução que a fez
 * segura o lock, ainda com o destinatário aberto, enquanto a outra o tenta.
 */
function pauseAfterFirstLock(pacing: PacingRedis) {
  const takeLock = pacing.set.getMockImplementation();
  if (!takeLock) throw new Error('set do pacing sem implementação');
  let reach!: () => void;
  let open!: () => void;
  const reached = new Promise<void>((resolve) => (reach = resolve));
  const opened = new Promise<void>((resolve) => (open = resolve));
  pacing.set.mockImplementationOnce((async (...args) => {
    const result = await takeLock(...args);
    reach();
    await opened;
    return result;
  }) as typeof takeLock);
  return { reached, open };
}

describe('I7 — duas execuções do mesmo lembrete (concorrência)', () => {
  it('a 2ª execução encontra o lock do pacing ocupado — exatamente um DelayedError; um pulo, Message CANCELLED, nenhuma chamada', async () => {
    const w = await buildT08World(deps);
    const ids = await seedDispatches(w);
    const { message } = w.deps.prisma;
    const prepared = await message.create({
      data: { instanceId: w.channelId, content: 'Lembrete' },
    });
    const id = await addPair(w, ids, w.people[0], {
      ackAt: ACK_AT,
      messageId: prepared.id,
    });
    await enqueue(w, id);
    const run = () => w.queue.runAttempt(w.processor, `${id}-i`, 1);

    const gate = pauseAfterFirstLock(w.pacing);
    const first = run();
    await gate.reached;
    // A 2ª carrega o destinatário ainda QUEUED e acha o número ocupado.
    await expect(run()).rejects.toBeInstanceOf(DelayedError);
    expect((await w.recipients(ids.reminderId))[0].status).toBe('QUEUED');
    gate.open();
    await first;
    // O job adiado volta: o destinatário já está fechado.
    await run();

    const [row] = await w.recipients(ids.reminderId);
    expect(row).toMatchObject({ status: 'SKIPPED', skipReason: 'ACKED' });
    expect(
      (await message.findUniqueOrThrow({ where: { id: prepared.id } })).status,
    ).toBe('CANCELLED');
    expect(w.provider.calls).toEqual([]);
    expect(w.pacing.held()).toEqual([]);
  }, 60_000);
});
