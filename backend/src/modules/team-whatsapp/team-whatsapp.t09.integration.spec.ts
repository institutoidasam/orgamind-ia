import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type * as PacingHelper from '../campaigns/pacing.helper';
import { ALERT_CONFIRM_SUFFIX, REMINDER_PREFIX } from './team-alert.rules';
import {
  startRecheckDeps,
  type RecheckDeps,
} from './team-whatsapp.schedule-recheck.test-fixtures';
import {
  ADMIN_NAME,
  ALERT_REASON,
  ALERT_TYPED,
  MANUAL_NOTE,
  REPLY_LATE_OK,
  REPLY_UNCLEAR,
  T0,
  at,
  buildT09World,
  phoneOf,
  secretsOf,
  trailOf,
  watchLogger,
  type Alert,
} from './team-whatsapp.t09.test-fixtures';

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

// Demonstração de T09 (cenário 10; aceites 6, 9, 15, 16 e 22) contra Postgres
// real, com os serviços de verdade e a resposta pela ingestão real (DI16). Só o
// provedor, a porta ao vivo, a fila e o Redis são falsos: nunca WhatsApp de
// verdade. As corridas "ciência manual × OK" e "desfazer × OK" são provadas de
// forma determinista em team-alert-manual-ack.integration.spec.ts (T6).
let deps: RecheckDeps;
let stop: () => Promise<void>;

beforeAll(async () => {
  ({ deps, stop } = await startRecheckDeps());
}, 180_000);

afterAll(async () => {
  await stop?.();
});

const isoAt = (minutes: number) => at(minutes).toISOString();

describe('cenário 10 — alerta a duas pessoas (aceite 6)', () => {
  it('cenário 10: alerta com motivo a duas pessoas — texto com a linha fixa, prazo de 15 min; A responde OK — Ciente com hora e texto; B em Sem resposta', async () => {
    const w = await buildT09World(deps);
    const alert = await w.sendAlert();

    // A revisão mostrou os nomes e o motivo; o alerta ficou gravado com o prazo.
    const names = alert.review.included.map((p) => p.name).sort();
    expect(names).toEqual(['Ana', 'Bia']);
    expect(alert.review.rule).toMatchObject({
      purpose: 'urgency',
      urgencyReason: ALERT_REASON,
      selectedCount: 2,
    });
    const stored = await w.storedAlert(alert.id);
    expect(stored).toEqual({
      purpose: 'URGENCY',
      urgencyReason: ALERT_REASON,
      text: ALERT_TYPED + ALERT_CONFIRM_SUFFIX,
      ackDeadlineMinutes: 15,
      createdAt: T0,
    });
    expect(await w.outboundTexts()).toEqual([stored.text, stored.text]);

    await w.reply(w.ana, 'OK', at(6));

    const panel = await w.panel(alert.id);
    expect(panel).toMatchObject({
      ackDeadlineAt: isoAt(15),
      counts: { noDelivery: 0, noReply: 1, replied: 0, acked: 1 },
    });
    expect(panel.people).toMatchObject([
      {
        recipientId: alert.bia,
        userName: 'Bia',
        group: 'no_reply',
        eligible: true,
        ack: null,
        ackReply: null,
      },
      {
        recipientId: alert.ana,
        userName: 'Ana',
        group: 'acked',
        ack: { at: isoAt(6), kind: 'keyword', late: false },
        ackReply: { text: 'OK', kind: 'TEXT', at: isoAt(6) },
      },
    ]);
  }, 60_000);
});

describe('cenário 10 — lembrete e ciência após o prazo (aceites 9 e 16)', () => {
  it('cenário 10: lembrete a B aos 10 min — ackDeadlineAt igual; B responde não entendi ao lembrete — Respondeu, sem ciência; Ok! aos 20 min — Ciente após o prazo', async () => {
    const w = await buildT09World(deps);
    const alert = await w.sendAlert();
    await w.reply(w.ana, 'OK', at(6));
    const before = await w.panel(alert.id);

    await expect(w.remind(alert.id, [alert.bia], 10)).resolves.toMatchObject({
      queued: 1,
    });
    await w.deliverReminders(alert.id, 10);
    // O lembrete não muda o "vence às" do alerta.
    const reminded = await w.panel(alert.id);
    expect(reminded.ackDeadlineAt).toBe(before.ackDeadlineAt);
    expect(reminded.reminders).toMatchObject({
      count: 1,
      max: 3,
      nextAllowedAt: isoAt(15),
      items: [{ recipients: 1, authorName: ADMIN_NAME, createdAt: isoAt(10) }],
    });

    // "não entendi" ao lembrete: Respondeu, sem ciência.
    await w.reply(w.bia, REPLY_UNCLEAR, at(12));
    const [unclear] = (await w.panel(alert.id)).people;
    expect(unclear).toMatchObject({
      userName: 'Bia',
      group: 'replied',
      ack: null,
      ackReply: null,
      lastReply: { text: REPLY_UNCLEAR, kind: 'TEXT', at: isoAt(12) },
    });

    // "Ok!" ao lembrete, 20 min depois: ciente no alerta original, após o prazo.
    await w.reply(w.bia, REPLY_LATE_OK, at(20));
    const late = await w.panel(alert.id);
    expect(late.ackDeadlineAt).toBe(before.ackDeadlineAt);
    expect(late.people.find((p) => p.userName === 'Bia')).toMatchObject({
      group: 'acked',
      ack: { at: isoAt(20), kind: 'keyword', late: true, byName: null },
      ackReply: { text: REPLY_LATE_OK, kind: 'TEXT', at: isoAt(20) },
    });
  }, 60_000);
});

describe('aceite 9 — lembrete com a ciência na fila', () => {
  it('aceite 9: A dá ciência com o lembrete na fila — Pulado: já confirmou, uma chamada ao provedor a menos', async () => {
    const w = await buildT09World(deps);
    const alert = await w.sendAlert();
    const { reminderId, queued } = await w.remind(
      alert.id,
      [alert.ana, alert.bia],
      10,
    );
    expect(queued).toBe(2);

    // A confirma enquanto o lembrete espera na fila; só então o processor roda.
    await w.reply(w.ana, 'OK', at(11));
    await w.deliverReminders(alert.id, 10);

    const [skipped, sent] = await w.recipients(reminderId);
    expect(skipped).toMatchObject({
      userName: 'Ana',
      status: 'SKIPPED',
      skipReason: 'ACKED',
      messageId: null,
      attempts: 0,
      channelCheckedAt: null,
    });
    expect(sent).toMatchObject({
      userName: 'Bia',
      status: 'SENT',
      attempts: 1,
    });
    // Dois alertas e um lembrete: três chamadas, e não quatro.
    expect(w.provider.calls).toHaveLength(3);
    expect(
      w.provider.calls.filter((c) => c.toE164 === phoneOf(w.ana)),
    ).toHaveLength(1);
    const texts = await w.outboundTexts();
    expect(texts).toHaveLength(3);
    expect(texts[2]).toBe(REMINDER_PREFIX + texts[0]);
    const ana = (await w.panel(alert.id)).people.find(
      (p) => p.userName === 'Ana',
    );
    expect(ana).toMatchObject({
      group: 'acked',
      ack: { at: isoAt(11), kind: 'keyword', late: false },
    });
  }, 60_000);
});

describe('aceite 22 — OK e ciência manual', () => {
  it('aceite 22: OK e ciência manual juntos; desfazer — automática com a hora do OK', async () => {
    const w = await buildT09World(deps);
    const alert = await w.sendAlert();
    await w.markManual(alert.id, alert.ana, 5);

    // O OK chega com a manual já gravada: a manual vale e o OK fica guardado.
    const okId = await w.reply(w.ana, 'OK', at(6));
    expect(await w.ackColumns(alert.ana)).toMatchObject({
      ackKind: 'MANUAL',
      ackAt: at(5),
      ackByUserId: w.site.adminId,
      ackNote: MANUAL_NOTE,
      ackMessageId: okId,
      ackMessageAt: at(6),
      lastReplyMessageId: okId,
    });
    const manual = (await w.panel(alert.id)).people.find(
      (p) => p.userName === 'Ana',
    );
    expect(manual?.ack).toEqual({
      at: isoAt(5),
      kind: 'manual',
      late: false,
      byName: ADMIN_NAME,
      note: MANUAL_NOTE,
    });

    // Desfazer a manual: a ciência passa a ser a do OK, com a hora dele.
    await w.undoManual(alert.id, alert.ana);
    expect(await w.ackColumns(alert.ana)).toMatchObject({
      ackKind: 'KEYWORD',
      ackAt: at(6),
      ackByUserId: null,
      ackNote: null,
      ackMessageId: okId,
    });
    const auto = (await w.panel(alert.id)).people.find(
      (p) => p.userName === 'Ana',
    );
    expect(auto?.ack).toEqual({
      at: isoAt(6),
      kind: 'keyword',
      late: false,
      byName: null,
      note: null,
    });
  }, 60_000);
});

describe('aceite 15 — dado pessoal fora da trilha e do log', () => {
  it('aceite 15: nenhuma trilha nem log do cenário contém os textos, a observação, os nomes ou os telefones', async () => {
    const w = await buildT09World(deps);
    const logs = watchLogger();
    let alert!: Alert;
    let logText = '';
    try {
      alert = await w.sendAlert();
      await w.markManual(alert.id, alert.ana, 5);
      await w.undoManual(alert.id, alert.ana);
      await w.remind(alert.id, [alert.ana, alert.bia], 10);
      await w.deliverReminders(alert.id, 10);
      await w.reply(w.bia, REPLY_UNCLEAR, at(12));
      // O rastreio cai na resposta seguinte: o log da falha é o que se confere.
      w.failNextTracking();
      await w.reply(w.bia, REPLY_LATE_OK, at(20));
    } finally {
      logText = logs.stop();
    }

    // A trilha do cenário: criação, ciência manual, desfazer e lembrete (só ids e contagens).
    const trail = trailOf(deps);
    expect(trail.actions).toEqual([
      'team_whatsapp.dispatch',
      'team_whatsapp.ack_manual',
      'team_whatsapp.ack_manual_undo',
      'team_whatsapp.reminder',
    ]);
    expect(logText).toContain('falha marcando');
    for (const secret of secretsOf(w)) {
      expect(trail.text).not.toContain(secret);
      expect(logText).not.toContain(secret);
    }
    // Falha no rastreio deixa a pessoa sem ciência; a mensagem recebida não se perde.
    expect(await w.ackColumns(alert.bia)).toMatchObject({ ackAt: null });
  }, 60_000);
});
