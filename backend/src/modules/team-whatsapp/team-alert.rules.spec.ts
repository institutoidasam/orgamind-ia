import { describe, expect, it } from 'vitest';
import type { MessageKind, TeamWhatsappRecipientStatus } from '@prisma/client';
import {
  ACK_REPLY_WINDOW_MS,
  ALERT_ACK_DEADLINE_MINUTES,
  ALERT_CONFIRM_SUFFIX,
  MAX_REMINDERS,
  REMINDER_INTERVAL_MS,
  alertDeadlineAt,
  alertGroupOf,
  alertText,
  bestStatusOf,
  isAckWord,
  reminderBlock,
  reminderEligibility,
  reminderText,
  withinReplyWindow,
  type AlertPersonFacts,
} from './team-alert.rules';

type Status = TeamWhatsappRecipientStatus;
const text = (value: string | null) => ({ kind: 'TEXT' as const, text: value });
const at = (iso: string) => new Date(iso);
const facts = (
  statuses: Status[],
  extra: Partial<AlertPersonFacts> = {},
): AlertPersonFacts => ({
  ackAt: null,
  lastReplyMessageId: null,
  statuses,
  ...extra,
});

describe('texto do alerta e do lembrete (DI3)', () => {
  it('alertText acrescenta linha em branco e a linha fixa; 41 caracteres', () => {
    expect(ALERT_CONFIRM_SUFFIX).toHaveLength(41);
    expect(alertText('Falta água')).toBe(
      'Falta água\n\nResponda OK para confirmar que recebeu.',
    );
    // sem aparar: o texto do usuário vai exatamente como veio
    expect(alertText(' x ')).toBe(` x ${ALERT_CONFIRM_SUFFIX}`);
  });

  it('reminderText prefixa Lembrete:', () => {
    expect(reminderText(alertText('Falta água'))).toBe(
      'Lembrete: Falta água\n\nResponda OK para confirmar que recebeu.',
    );
  });
});

describe('palavra de ciência (DI5, aceite 7)', () => {
  it('aceite 7: Ok!, OK, Ciente., confirmo, Recebido, 👍, 👍🏽 e 👍 com FE0F — ciência', () => {
    const accepted = [
      'Ok!',
      'OK',
      'Ciente.',
      'confirmo',
      'Recebido',
      '  CÍENTE!!  ',
      '¡Ciente!',
      '"Ok"',
      '👍',
      '👍🏽',
      '👍️',
    ];
    for (const value of accepted) {
      expect(isAckWord(text(value)), value).toBe(true);
    }
  });

  it('aceite 7: ok, mas não vou; não entendi; okay; texto vazio — não', () => {
    const refused = ['ok, mas não vou', 'não entendi', 'okay', '', '  ', '...'];
    for (const value of refused) {
      expect(isAckWord(text(value)), value).toBe(false);
    }
    expect(isAckWord(text(null))).toBe(false);
  });
});

describe('ciência: tipo da mensagem e janela (DI5, DI6)', () => {
  it('IMAGE e VIDEO com legenda ok, AUDIO, STICKER e UNSUPPORTED — não', () => {
    const kinds: MessageKind[] = [
      'IMAGE',
      'VIDEO',
      'AUDIO',
      'DOCUMENT',
      'STICKER',
      'LOCATION',
      'CONTACT',
      'UNSUPPORTED',
    ];
    for (const kind of kinds) {
      expect(isAckWord({ kind, text: 'ok' }), kind).toBe(false);
      expect(isAckWord({ kind, text: null }), kind).toBe(false);
    }
  });

  it('janela: 24 h exatas vale, 24 h e 1 ms não', () => {
    const accepted = at('2026-11-20T12:00:00.000Z');
    const edge = new Date(accepted.getTime() + ACK_REPLY_WINDOW_MS);
    expect(withinReplyWindow(accepted, edge)).toBe(true);
    expect(withinReplyWindow(accepted, new Date(edge.getTime() + 1))).toBe(
      false,
    );
    expect(withinReplyWindow(accepted, new Date(edge.getTime() - 1))).toBe(
      true,
    );
  });
});

describe('grupo e melhor estado (DI8, I6)', () => {
  it('grupo de cada caso de I6, inclusive incerto que recebeu lembrete → no_reply', () => {
    const ackAt = at('2026-11-20T12:05:00.000Z');
    const cases: [AlertPersonFacts, string][] = [
      [facts(['SENT'], { ackAt }), 'acked'],
      [facts([], { ackAt }), 'acked'],
      [facts(['SENT'], { lastReplyMessageId: 'm1' }), 'replied'],
      [facts(['FAILED'], { lastReplyMessageId: 'm1' }), 'replied'],
      [facts(['SENT', 'REPLIED']), 'replied'],
      [facts(['SENT']), 'no_reply'],
      [facts(['QUEUED', 'DELIVERED']), 'no_reply'],
      [facts(['FAILED', 'READ']), 'no_reply'],
      [facts(['UNCERTAIN', 'SENT']), 'no_reply'],
      [facts(['UNCERTAIN']), 'no_delivery'],
      [facts(['FAILED']), 'no_delivery'],
      [facts(['SKIPPED', 'SKIPPED']), 'no_delivery'],
      [facts(['QUEUED', 'CANCELLED']), 'no_delivery'],
    ];
    for (const [input, group] of cases) {
      expect(alertGroupOf(input), JSON.stringify(input)).toBe(group);
    }
  });

  it('bestStatusOf segue a ordem de DI8', () => {
    const order: Status[] = [
      'REPLIED',
      'READ',
      'DELIVERED',
      'SENT',
      'UNCERTAIN',
      'QUEUED',
      'SCHEDULED',
      'FAILED',
      'SKIPPED',
      'CANCELLED',
    ];
    order.forEach((best, i) => {
      expect(bestStatusOf([...order.slice(i)].reverse()), best).toBe(best);
    });
    expect(() => bestStatusOf([])).toThrow(RangeError);
  });
});

describe('elegíveis ao lembrete (DI8, I7)', () => {
  it('elegíveis: no_reply, replied e incerto (mayHaveReceived); falhou, pulado, na fila e ciente não', () => {
    const ackAt = at('2026-11-20T12:05:00.000Z');
    const yes = { eligible: true, mayHaveReceived: false };
    const maybe = { eligible: true, mayHaveReceived: true };
    const no = { eligible: false, mayHaveReceived: false };
    const cases: [AlertPersonFacts, unknown][] = [
      [facts(['SENT']), yes],
      [facts(['READ'], { lastReplyMessageId: 'm1' }), yes],
      [facts(['UNCERTAIN', 'SENT']), yes],
      [facts(['UNCERTAIN']), maybe],
      [facts(['UNCERTAIN', 'FAILED']), maybe],
      [facts(['FAILED']), no],
      [facts(['SKIPPED', 'QUEUED']), no],
      [facts(['QUEUED']), no],
      [facts(['SCHEDULED', 'CANCELLED']), no],
      [facts(['SENT'], { ackAt }), no],
      [facts(['UNCERTAIN'], { ackAt }), no],
    ];
    for (const [input, expected] of cases) {
      expect(reminderEligibility(input), JSON.stringify(input)).toEqual(
        expected,
      );
    }
  });
});

describe('limite, intervalo e prazo (DI4, I7)', () => {
  const alertCreatedAt = at('2026-11-20T12:00:00.000Z');
  const plus = (base: Date, ms: number) => new Date(base.getTime() + ms);

  it('reminderBlock: limite antes do intervalo; 5 min contam do alerta e depois do último lembrete', () => {
    const block = (
      reminderCount: number,
      lastReminderAt: Date | null,
      now: Date,
    ) => reminderBlock({ reminderCount, lastReminderAt, alertCreatedAt, now });
    expect(MAX_REMINDERS).toBe(3);
    // do alerta, enquanto não há lembrete
    expect(block(0, null, plus(alertCreatedAt, REMINDER_INTERVAL_MS - 1))).toBe(
      'reminder_too_soon',
    );
    expect(block(0, null, plus(alertCreatedAt, REMINDER_INTERVAL_MS))).toBe(
      null,
    );
    // do último lembrete, não do alerta
    const last = plus(alertCreatedAt, 20 * 60_000);
    expect(block(1, last, plus(last, REMINDER_INTERVAL_MS - 1))).toBe(
      'reminder_too_soon',
    );
    expect(block(2, last, plus(last, REMINDER_INTERVAL_MS))).toBe(null);
    // o limite vence o intervalo, cedo ou tarde
    expect(block(3, last, plus(last, 1))).toBe('reminder_limit');
    expect(block(3, last, plus(last, 60 * 60_000))).toBe('reminder_limit');
  });

  it('alertDeadlineAt = createdAt + 15 min', () => {
    expect(ALERT_ACK_DEADLINE_MINUTES).toBe(15);
    expect(
      alertDeadlineAt(alertCreatedAt, ALERT_ACK_DEADLINE_MINUTES).toISOString(),
    ).toBe('2026-11-20T12:15:00.000Z');
  });
});
