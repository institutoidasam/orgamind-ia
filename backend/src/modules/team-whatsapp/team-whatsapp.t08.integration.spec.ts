import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type * as PacingHelper from '../campaigns/pacing.helper';
import { INDETERMINATE_CODE } from './team-whatsapp.outcome';
import {
  buildT08World,
  listedRecipients,
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

// Demonstração de T08 para a GBR (H6, cenários 1 a 3, DH11), contra Postgres
// real e só com a porta do provedor e a porta ao vivo falsas: nunca WhatsApp de
// verdade, telefones fictícios. As regras já existem; o teste as prova ponta a
// ponta. Cada teste monta o seu mundo (setor, número e três pessoas próprios).
const DISCONNECTED = 'team_whatsapp.channel_disconnected';
const TIMEOUT = 'evolution.timeout';

let deps: RecheckDeps;
let stop: () => Promise<void>;

beforeAll(async () => {
  ({ deps, stop } = await startRecheckDeps());
}, 180_000);

afterAll(async () => {
  await stop?.();
});

/** Prévia com o número aberto, número que cai, confirmação: 409. */
async function confirmWithNumberDown(w: T08World) {
  const preview = await w.preview();
  w.live.respond('close');
  return w.confirm(preview);
}

describe('T08 cenário 1 — número desconectado na confirmação', () => {
  it('cenário 1: número desconectado na confirmação — 409 e nenhuma linha de envio ou destinatário', async () => {
    const w = await buildT08World(deps);

    await expect(confirmWithNumberDown(w)).rejects.toMatchObject({
      status: 409,
      code: DISCONNECTED,
    });

    const { prisma } = deps;
    expect(
      await prisma.teamWhatsappDispatch.count({
        where: { sectors: { some: { sectorId: w.site.sectorId } } },
      }),
    ).toBe(0);
    expect(
      await prisma.teamWhatsappRecipient.count({
        where: { userId: { in: w.people.map((p) => p.id) } },
      }),
    ).toBe(0);
    expect(w.queue.jobIds()).toEqual([]);
    expect(w.provider.calls).toEqual([]);
    expect(await w.messages()).toEqual([]);
  }, 60_000);
});

/**
 * Envio para as três pessoas; a 1ª conferência da fila vê o número aberto e o
 * número cai em seguida. Devolve o id da 1ª (o job que entrou primeiro).
 */
async function sendThenNumberDrops() {
  const w = await buildT08World(deps);
  const sent = await w.sendNow();
  expect(sent).toMatchObject({ queued: 3 });
  w.live.respond('open', 'close');
  await w.queue.drain(w.processor);
  const [firstId] = w.queue.jobIds();
  return { w, dispatchId: sent.dispatchId, firstId };
}

describe('T08 cenário 2 — o número cai no meio da fila', () => {
  it('cenário 2: número cai depois da 1ª pessoa — a 1ª Aceito com hora, as outras Falhou: número desconectado sem hora; nenhum SENT sem Message aceita', async () => {
    const { w, dispatchId, firstId } = await sendThenNumberDrops();

    const rows = await w.recipients(dispatchId);
    const first = rows.find((r) => r.id === firstId);
    const others = rows.filter((r) => r.id !== firstId);
    expect(first).toMatchObject({
      status: 'SENT',
      attempts: 1,
      errorCode: null,
      channelCheckedAt: T08_CHECKED_AT,
    });
    expect(first?.acceptedAt).toBeInstanceOf(Date);
    // Falhou antes do provedor: sem tentativa, sem Message, sem aceite, sem hora.
    const failedBefore = {
      status: 'FAILED',
      errorCode: DISCONNECTED,
      attempts: 0,
      messageId: null,
      acceptedAt: null,
      channelCheckedAt: null,
    };
    expect(others).toEqual([
      expect.objectContaining(failedBefore),
      expect.objectContaining(failedBefore),
    ]);
    // Nenhum SENT sem Message aceita: um SENT, uma Message SENT dele, uma chamada.
    const [message] = await w.messages();
    expect(await w.messages()).toHaveLength(1);
    expect(message).toMatchObject({
      id: first?.messageId,
      status: 'SENT',
      errorCode: null,
      sentAt: T08_ACCEPTED_AT,
    });
    expect(message.providerMessageId).toMatch(/^wamid-falso-\d+$/);
    expect(rows.filter((r) => r.status === 'SENT')).toHaveLength(1);
    expect(w.provider.calls).toHaveLength(1);
    expect(w.pacing.held()).toEqual([]);
  }, 60_000);
});

describe('T08 cenário 2 — reconexão e "Repetir"', () => {
  it('cenário 2: reconecta e Repetir manda só os falhos, uma chamada ao provedor cada; uma Message por pessoa e a da 1ª inalterada', async () => {
    const { w, dispatchId, firstId } = await sendThenNumberDrops();
    const failed = (await w.recipients(dispatchId))
      .filter((r) => r.status === 'FAILED')
      .map((r) => r.id);
    const [firstMessage] = await w.messages();

    w.live.respond('open');
    await expect(w.retryAll(dispatchId)).resolves.toEqual({ requeued: 2 });
    // Só os falhos voltam à fila, cada um com o jobId novo da repetição (D12).
    expect(w.queue.jobIds().slice(3).sort()).toEqual(
      failed.map((id) => `${id}-r1`).sort(),
    );
    await w.queue.drain(w.processor);

    const rows = await w.recipients(dispatchId);
    expect(rows.map((r) => r.status)).toEqual(['SENT', 'SENT', 'SENT']);
    // A 1ª nunca foi repetida; só as duas que falharam (manualRetries 1).
    expect(rows.find((r) => r.id === firstId)?.manualRetries).toBe(0);
    expect(rows.filter((r) => r.manualRetries === 1)).toHaveLength(2);
    // Uma Message por pessoa (a da 1ª é a mesma) e uma chamada por Message.
    const messages = await w.messages();
    expect(messages).toHaveLength(3);
    expect(messages[0]).toEqual(firstMessage);
    expect(w.provider.calls).toHaveLength(3);
    expect(rows.map((r) => w.provider.callsOf(r.messageId ?? ''))).toEqual([
      1, 1, 1,
    ]);
    expect(rows.map((r) => r.channelCheckedAt)).toEqual([
      T08_CHECKED_AT,
      T08_CHECKED_AT,
      T08_CHECKED_AT,
    ]);
  }, 60_000);
});

/** Envio para as três pessoas; o provedor dá timeout na 1ª chamada e aceita as outras. */
async function sendWithTimeoutOnFirst() {
  const w = await buildT08World(deps);
  w.provider.respond('timeout', 'accept');
  const sent = await w.sendNow();
  await w.queue.drain(w.processor);
  const [firstId] = w.queue.jobIds();
  const rows = await w.recipients(sent.dispatchId);
  const uncertain = rows.find((r) => r.id === firstId);
  if (!uncertain?.messageId) throw new Error('1ª pessoa sem Message');
  const { id, messageId } = uncertain;
  return { w, dispatchId: sent.dispatchId, uncertain, id, messageId, rows };
}

const rowOf = async (w: T08World, dispatchId: string, id: string) =>
  (await w.recipients(dispatchId)).find((r) => r.id === id);
const messageOf = async (w: T08World, id: string) =>
  (await w.messages()).find((m) => m.id === id);

/** Destinatário de volta a QUEUED (SQL cru), com a Message da tentativa como estava. */
async function reopenAsAfterCrash(w: T08World, dispatchId: string, id: string) {
  await deps.prisma.$executeRaw`
    UPDATE "TeamWhatsappRecipient"
    SET "status" = 'QUEUED', "errorCode" = NULL
    WHERE "id" = ${id}`;
  expect(await rowOf(w, dispatchId, id)).toMatchObject({ status: 'QUEUED' });
}

describe('T08 cenário 3 — timeout do provedor', () => {
  it('cenário 3: timeout do provedor — Situação incerta, repeatable false, Repetir devolve 0; reexecutar o job com o destinatário QUEUED e a Message FAILED evolution.timeout não chama o provedor de novo', async () => {
    const { w, dispatchId, uncertain, id, messageId, rows } =
      await sendWithTimeoutOnFirst();

    // Uma chamada, o timeout; o `settle` grava UNCERTAIN na 1ª execução, sem lançar.
    expect(uncertain).toMatchObject({
      status: 'UNCERTAIN',
      errorCode: TIMEOUT,
      attempts: 1,
      channelCheckedAt: T08_CHECKED_AT,
    });
    expect(await w.queue.getState(id)).toBe('completed');
    expect((await w.queue.getJob(id))?.attemptsMade).toBe(0);
    expect(w.provider.callsOf(messageId)).toBe(1);
    expect(rows.filter((r) => r.status === 'SENT')).toHaveLength(2);
    // Fora do "Repetir": a API não o oferece como repetível e a troca não o pega.
    const listed = await listedRecipients(w, dispatchId);
    expect(listed.find((item) => item.id === id)).toMatchObject({
      status: 'UNCERTAIN',
      repeatable: false,
    });
    await expect(w.retryAll(dispatchId)).resolves.toEqual({ requeued: 0 });
    expect(w.queue.jobIds()).toHaveLength(3);

    // Queda do worker entre a Message FAILED e a gravação do destinatário.
    await reopenAsAfterCrash(w, dispatchId, id);
    expect(await messageOf(w, messageId)).toMatchObject({
      status: 'FAILED',
      errorCode: TIMEOUT,
    });
    await w.queue.runAttempt(w.processor, id, 1);

    // A Message decide: continua incerto e o provedor não é chamado de novo.
    // O código vira `indeterminate` (comportamento de hoje, `priorOutcome`).
    expect(await rowOf(w, dispatchId, id)).toMatchObject({
      status: 'UNCERTAIN',
      errorCode: INDETERMINATE_CODE,
      attempts: 1,
      messageId,
    });
    expect(w.provider.callsOf(messageId)).toBe(1);
    expect(w.provider.calls).toHaveLength(3);
    expect(await messageOf(w, messageId)).toMatchObject({
      status: 'FAILED',
      errorCode: TIMEOUT,
    });
    await expect(w.retryAll(dispatchId)).resolves.toEqual({ requeued: 0 });
  }, 60_000);
});
