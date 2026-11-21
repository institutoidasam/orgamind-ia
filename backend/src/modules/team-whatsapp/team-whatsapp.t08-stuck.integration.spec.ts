import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type * as PacingHelper from '../campaigns/pacing.helper';
import { STUCK_CODE } from './stuck-recipients';
import {
  buildStuckTools,
  buildT08World,
  holdChannel,
  itemOf,
  recipientOf,
  strand,
  T08_ACCEPTED_AT,
  T08_CHECKED_AT,
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

// Demonstração de T08 para a GBR (H6, cenários 4 a 6, DH11): recibos fora de
// ordem, dois "Repetir" ao mesmo tempo e o verificador de presos ponta a ponta,
// contra Postgres real. Reais: o rastreio, o "Repetir", o processor, o chat e
// o verificador (T4/T5); falsos: só a porta do provedor, a porta ao vivo, a
// fila em memória e o Redis do pacing. Nunca WhatsApp de verdade. `now` do
// verificador é explícito e o `updatedAt` do preso vai por SQL cru (`strand`).
const QUEUE_LOST = 'team_whatsapp.queue_lost';
const NOT_CONNECTED = 'evolution.not_connected';

let deps: RecheckDeps;
let stop: () => Promise<void>;

beforeAll(async () => {
  ({ deps, stop } = await startRecheckDeps());
}, 180_000);

afterAll(async () => {
  await stop?.();
});

// Os mundos dos testes anteriores dividem o banco e deixam presos (QUEUED
// parados) cujo job vive em OUTRA fila em memória: o verificador deste mundo os
// leria como perdidos. Cancelados, saem da conta.
beforeEach(async () => {
  await deps.prisma.$executeRaw`
    UPDATE "TeamWhatsappRecipient" SET "status" = 'CANCELLED'
    WHERE "status" = 'QUEUED'`;
});

/** Envio "agora" para Ana, Bia e Caio; nenhum job rodou (os três esperam na fila). */
async function sentToThree() {
  const w = await buildT08World(deps);
  const sent = await w.sendNow();
  const [ana, bia, caio] = (await w.recipients(sent.dispatchId)).map(
    (r) => r.id,
  );
  const { dispatchId } = sent;
  return { w, tools: buildStuckTools(w), dispatchId, ana, bia, caio };
}
type Sent = Awaited<ReturnType<typeof sentToThree>>;

/** O worker cai com o job: ele some da fila e o destinatário fica parado há 31 min. */
async function loseJob({ w }: Sent, id: string, now: Date): Promise<void> {
  w.queue.lose(id);
  await strand(deps.prisma, id, now);
}

/** O que o verificador nunca mexe: a fila, o provedor, a conferência ao vivo e o lock do pacing. */
const footprint = (w: T08World) => ({
  jobs: w.queue.jobIds(),
  providerCalls: w.provider.calls.length,
  liveChecks: w.live.check.mock.calls.length,
  held: w.pacing.held(),
});

/** 1ª tentativa: prepara a Message (QUEUED), conta a tentativa e lança antes do provedor. */
async function prepareThenThrow(w: T08World, id: string): Promise<void> {
  w.provider.supportsInboxChatFor
    .mockReturnValueOnce(true)
    .mockImplementationOnce(() => {
      throw new Error('worker caiu');
    });
  await expect(w.queue.runAttempt(w.processor, id, 0)).rejects.toThrow();
}

/** O worker cai no meio da chamada ao provedor: a Message fica SENDING e a chamada nunca volta. */
async function hangInProviderCall(w: T08World, id: string): Promise<void> {
  w.provider.sendChatText.mockImplementationOnce(
    () => new Promise<never>(() => undefined),
  );
  void w.queue.runAttempt(w.processor, id, 0);
  await vi.waitFor(
    async () => {
      expect((await w.messages()).map((m) => m.status)).toContain('SENDING');
    },
    { timeout: 10_000 },
  );
}

/**
 * O provedor recusa (número desconectado) e o worker cai antes da retentativa:
 * Message FAILED reenviável, destinatário QUEUED parado e job perdido.
 */
async function strandAfterRefusal(s: Sent, id: string) {
  const { w } = s;
  w.provider.respond('not_connected', 'accept');
  await expect(w.queue.runAttempt(w.processor, id, 0)).rejects.toThrow();
  const [failed] = await w.messages();
  expect(failed).toMatchObject({ status: 'FAILED', errorCode: NOT_CONNECTED });
  const now = new Date();
  await loseJob(s, id, now);
  return { failed, now };
}

/** "Repetir" todos os falhos e roda só o job novo (`-r1`) de cada pessoa dada. */
async function repeatAndSend(w: T08World, dispatchId: string, ids: string[]) {
  const retried = await w.retryAll(dispatchId);
  for (const id of ids) await w.queue.runAttempt(w.processor, `${id}-r1`, 0);
  return retried;
}

/** Três presos, um de cada ramo: Ana sem Message, Bia com Message QUEUED, Caio com Message aceita. */
async function strandedMix() {
  const s = await sentToThree();
  await prepareThenThrow(s.w, s.bia);
  await s.w.queue.runAttempt(s.w.processor, s.caio, 0);
  const now = new Date();
  for (const id of [s.ana, s.bia, s.caio]) await loseJob(s, id, now);
  return { ...s, now };
}

const at = (minutes: number) =>
  new Date(T08_ACCEPTED_AT.getTime() + minutes * 60_000);

/**
 * Recibo como o webhook o entrega: a Message só sobe de posto e o rastreio
 * recebe o evento. O rastreio recebe SEMPRE, mesmo com a Message sem mudar (o
 * evento reentregue ou atrasado), para provar a guarda dele.
 */
async function deliverReceipt(
  tracking: ReturnType<typeof buildStuckTools>['tracking'],
  messageId: string,
  status: 'DELIVERED' | 'READ',
  occurredAt: Date,
): Promise<number> {
  const read = status === 'READ';
  await deps.prisma.message.updateMany({
    where: {
      id: messageId,
      status: { in: read ? ['SENT', 'DELIVERED'] : ['SENT'] },
    },
    data: read
      ? { status, readAt: occurredAt }
      : { status, deliveredAt: occurredAt },
  });
  return tracking.applyReceipt({ messageId, status, occurredAt });
}

describe('T08 cenário 4 — recibos repetidos e fora de ordem', () => {
  it('cenário 4: lido antes de entregue e entregue duas vezes — segue Lido, deliveredAt não regride, nenhuma Message nova', async () => {
    const { w, tools, dispatchId, ana, bia } = await sentToThree();
    await w.queue.drain(w.processor);
    const [sentAna, sentBia] = [
      await recipientOf(w, dispatchId, ana),
      await recipientOf(w, dispatchId, bia),
    ];
    const before = {
      ids: (await w.messages()).map((m) => m.id),
      ...footprint(w),
    };
    const receipt = (
      row: typeof sentAna,
      status: 'DELIVERED' | 'READ',
      min: number,
    ) => deliverReceipt(tools.tracking, row.messageId ?? '', status, at(min));

    // Ana: lido às +2; o "entregue" das +1 chega depois, duas vezes.
    expect(await receipt(sentAna, 'READ', 2)).toBe(1);
    expect(await receipt(sentAna, 'DELIVERED', 1)).toBe(0);
    expect(await receipt(sentAna, 'DELIVERED', 1)).toBe(0);
    // Bia: entregue às +1; o mesmo evento reentregue às +3 não mexe na hora.
    expect(await receipt(sentBia, 'DELIVERED', 1)).toBe(1);
    expect(await receipt(sentBia, 'DELIVERED', 3)).toBe(0);

    expect(await recipientOf(w, dispatchId, ana)).toMatchObject({
      status: 'READ',
      acceptedAt: sentAna.acceptedAt,
    });
    expect(await itemOf(w, dispatchId, ana)).toMatchObject({
      status: 'READ',
      readAt: at(2).toISOString(),
      deliveredAt: at(2).toISOString(),
    });
    expect(await itemOf(w, dispatchId, bia)).toMatchObject({
      status: 'DELIVERED',
      deliveredAt: at(1).toISOString(),
      readAt: null,
    });
    expect({
      ids: (await w.messages()).map((m) => m.id),
      ...footprint(w),
    }).toEqual(before);
  }, 60_000);
});

describe('T08 cenário 5 — dois "Repetir" ao mesmo tempo', () => {
  it('cenário 5: dois Repetir ao mesmo tempo — um job e uma chamada ao provedor por pessoa', async () => {
    const { w, dispatchId, ana, bia, caio } = await sentToThree();
    w.live.respond('close');
    await w.queue.drain(w.processor); // número caído: as três falham antes do provedor
    w.live.respond('open');
    const addBulk = vi.spyOn(w.queue, 'addBulk');

    const [first, second] = await Promise.all([
      w.retryAll(dispatchId),
      w.retryAll(dispatchId),
    ]);

    // O UPDATE ... RETURNING atômico entrega cada linha a uma só das chamadas.
    expect(first.requeued + second.requeued).toBe(3);
    const queued = addBulk.mock.calls.flatMap(([jobs]) =>
      jobs.map((job) => job.opts.jobId),
    );
    expect(queued.sort()).toEqual(
      [ana, bia, caio].map((id) => `${id}-r1`).sort(),
    );
    await w.queue.drain(w.processor);
    const rows = await w.recipients(dispatchId);
    expect(rows.map((r) => [r.status, r.manualRetries])).toEqual([
      ['SENT', 1],
      ['SENT', 1],
      ['SENT', 1],
    ]);
    expect(await w.messages()).toHaveLength(3);
    expect(w.provider.calls).toHaveLength(3);
    expect(rows.map((r) => w.provider.callsOf(r.messageId ?? ''))).toEqual([
      1, 1, 1,
    ]);
  }, 60_000);
});

describe('T08 cenário 6 — preso sem Message e com Message QUEUED', () => {
  it('cenário 6: sem Message e com Message QUEUED — Falhou: saiu da fila sem envio; Repetir manda uma vez, sem segunda Message; a Message QUEUED virou FAILED antes do Repetir', async () => {
    const s = await sentToThree();
    const { w, tools, dispatchId, ana, bia } = s;
    await prepareThenThrow(w, bia);
    const [queuedMessage] = await w.messages();
    expect(queuedMessage).toMatchObject({ status: 'QUEUED' });
    const now = new Date();
    await loseJob(s, ana, now);
    await loseJob(s, bia, now);
    const before = footprint(w);

    expect(await tools.reconciler.reconcile(now)).toMatchObject({
      checked: 2,
      lost: 2,
      counts: { queueLost: 2 },
    });

    for (const id of [ana, bia]) {
      expect(await recipientOf(w, dispatchId, id)).toMatchObject({
        status: 'FAILED',
        errorCode: QUEUE_LOST,
      });
      expect(await itemOf(w, dispatchId, id)).toMatchObject({
        reason: QUEUE_LOST,
        repeatable: true,
      });
    }
    // Aceite 21: a Message QUEUED não fica "na fila" no chat; nada saiu nem entrou na fila.
    expect(await w.messages()).toEqual([
      { ...queuedMessage, status: 'FAILED', errorCode: QUEUE_LOST },
    ]);
    expect(footprint(w)).toEqual(before);

    await expect(repeatAndSend(w, dispatchId, [ana, bia])).resolves.toEqual({
      requeued: 2,
    });
    // Uma Message por pessoa (a de Bia reaproveitada) e uma chamada por pessoa.
    const messages = await w.messages();
    expect(messages).toHaveLength(2);
    expect(messages.map((m) => m.status)).toEqual(['SENT', 'SENT']);
    expect(messages[0].id).toBe(queuedMessage.id);
    expect(w.provider.calls).toHaveLength(2);
    expect(w.provider.callsOf(queuedMessage.id)).toBe(1);
  }, 60_000);
});

describe('T08 cenário 6 — preso com Message aceita', () => {
  it('cenário 6: Message aceita — Aceito pelo WhatsApp, sem chamada ao provedor', async () => {
    const s = await sentToThree();
    const { w, tools, dispatchId, ana } = s;
    await w.queue.runAttempt(w.processor, ana, 0); // o provedor aceita
    const [accepted] = await w.messages();
    const now = new Date();
    await loseJob(s, ana, now); // o worker caiu antes de gravar o desfecho
    expect(await recipientOf(w, dispatchId, ana)).toMatchObject({
      status: 'QUEUED',
      acceptedAt: null,
      messageId: accepted.id,
    });
    const before = footprint(w);

    expect(await tools.reconciler.reconcile(now)).toMatchObject({
      checked: 1,
      lost: 1,
      counts: { sent: 1 },
    });

    expect(await recipientOf(w, dispatchId, ana)).toMatchObject({
      status: 'SENT',
      errorCode: null,
      acceptedAt: T08_ACCEPTED_AT,
      messageId: accepted.id,
    });
    expect(await itemOf(w, dispatchId, ana)).toMatchObject({
      status: 'SENT',
      repeatable: false,
    });
    expect(footprint(w)).toEqual(before);
    expect(w.provider.calls).toHaveLength(1);
    expect(await w.messages()).toEqual([accepted]);
  }, 60_000);
});

describe('T08 cenário 6 — preso com Message SENDING e com timeout', () => {
  it('cenário 6: Message SENDING e FAILED por timeout — Situação incerta, fora do Repetir', async () => {
    const s = await sentToThree();
    const { w, tools, dispatchId, ana, bia } = s;
    w.provider.respond('timeout');
    await w.queue.runAttempt(w.processor, bia, 0); // timeout: Message FAILED evolution.timeout
    await hangInProviderCall(w, ana); // Ana: Message SENDING, a chamada nunca volta
    const now = new Date();
    await loseJob(s, ana, now);
    await loseJob(s, bia, now);
    const [before, messages] = [footprint(w), await w.messages()];
    expect(messages.map((m) => m.status).sort()).toEqual(['FAILED', 'SENDING']);

    expect(await tools.reconciler.reconcile(now)).toMatchObject({
      checked: 2,
      lost: 2,
      counts: { uncertain: 2 },
    });

    for (const id of [ana, bia]) {
      expect(await recipientOf(w, dispatchId, id)).toMatchObject({
        status: 'UNCERTAIN',
        errorCode: STUCK_CODE,
      });
      expect(await itemOf(w, dispatchId, id)).toMatchObject({
        status: 'UNCERTAIN',
        repeatable: false,
      });
    }
    await expect(w.retryAll(dispatchId)).resolves.toEqual({ requeued: 0 });
    expect(footprint(w)).toEqual(before);
    expect(await w.messages()).toEqual(messages);
  }, 60_000);
});

describe('T08 cenário 6 — preso com Message FAILED reenviável', () => {
  it('cenário 6: Message FAILED reenviável — Falhou com o código dela, Repetir a reaproveita', async () => {
    const s = await sentToThree();
    const { w, tools, dispatchId, ana } = s;
    const { failed, now } = await strandAfterRefusal(s, ana);
    const before = footprint(w);

    expect(await tools.reconciler.reconcile(now)).toMatchObject({
      checked: 1,
      lost: 1,
      counts: { failed: 1 },
    });

    expect(await recipientOf(w, dispatchId, ana)).toMatchObject({
      status: 'FAILED',
      errorCode: NOT_CONNECTED,
      attempts: 1,
      messageId: failed.id,
    });
    expect(await itemOf(w, dispatchId, ana)).toMatchObject({
      reason: NOT_CONNECTED,
      repeatable: true,
    });
    // Nada é reenviado sozinho: só o Repetir manda, e na mesma Message.
    expect(footprint(w)).toEqual(before);
    await expect(repeatAndSend(w, dispatchId, [ana])).resolves.toEqual({
      requeued: 1,
    });
    const messages = await w.messages();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ id: failed.id, status: 'SENT' });
    expect(w.provider.callsOf(failed.id)).toBe(2);
    expect(await recipientOf(w, dispatchId, ana)).toMatchObject({
      status: 'SENT',
      messageId: failed.id,
      manualRetries: 1,
    });
  }, 60_000);
});

describe('T08 aceite 3 — job esperando com pacing', () => {
  it('aceite 3: job esperando (delayed) há mais de 30 min não muda', async () => {
    const { w, tools, dispatchId } = await sentToThree();
    await holdChannel(w);
    await w.queue.drain(w.processor); // pacing: os três jobs ficam `delayed`
    const rows = await w.recipients(dispatchId);
    const states = await Promise.all(rows.map((r) => w.queue.getState(r.id)));
    expect(states).toEqual(['delayed', 'delayed', 'delayed']);
    const now = new Date();
    for (const { id } of rows) await strand(deps.prisma, id, now);
    deps.audit.log.mockClear();

    const cycle = await tools.reconciler.reconcile(now);

    expect(cycle).toMatchObject({ checked: 3, alive: 3, lost: 0 });
    expect(await w.recipients(dispatchId)).toEqual(rows);
    expect(rows.map((r) => r.status)).toEqual(['QUEUED', 'QUEUED', 'QUEUED']);
    expect(deps.audit.log).not.toHaveBeenCalled();
    expect(w.provider.calls).toEqual([]);
    expect(await w.messages()).toEqual([]);
  }, 60_000);
});

describe('T08 cenário 6 — o verificador não reenvia', () => {
  it('cenário 6: o verificador não enfileira nem chama o provedor', async () => {
    const { w, tools, dispatchId, now } = await strandedMix();
    const before = footprint(w);
    const addBulk = vi.spyOn(w.queue, 'addBulk');

    const cycle = await tools.reconciler.reconcile(now);

    expect(cycle).toMatchObject({
      checked: 3,
      lost: 3,
      counts: { queueLost: 2, sent: 1 },
    });
    expect(addBulk).not.toHaveBeenCalled();
    expect(footprint(w)).toEqual(before);
    // Nenhuma Message passou por SENDING: Bia (QUEUED) falhou, Caio segue aceita.
    expect((await w.messages()).map((m) => m.status).sort()).toEqual([
      'FAILED',
      'SENT',
    ]);
    // Trilha só com id e contagens (GH3).
    expect(deps.audit.log).toHaveBeenCalledWith(
      'team_whatsapp.stuck_reconciled',
      'TeamWhatsappDispatch',
      dispatchId,
      {
        dispatchId,
        queueLost: 2,
        missing: 0,
        sent: 1,
        failed: 0,
        uncertain: 0,
      },
    );
  }, 60_000);
});

describe('T08 cenário 6 — hora da conferência', () => {
  it('cenário 6: o verificador preserva a hora da conferência (channelCheckedAt)', async () => {
    const { w, tools, dispatchId, now } = await strandedMix();
    const checkedAt = async () =>
      (await w.recipients(dispatchId)).map((r) => r.channelCheckedAt);
    // Ana nunca chegou à conferência; Bia e Caio passaram por ela antes de parar.
    expect(await checkedAt()).toEqual([null, T08_CHECKED_AT, T08_CHECKED_AT]);

    await tools.reconciler.reconcile(now);

    expect((await w.recipients(dispatchId)).map((r) => r.status)).toEqual([
      'FAILED',
      'FAILED',
      'SENT',
    ]);
    expect(await checkedAt()).toEqual([null, T08_CHECKED_AT, T08_CHECKED_AT]);
  }, 60_000);
});
