import { describe, expect, it } from 'vitest';
import { teamAlertPanelSchema } from './team-whatsapp.schema';

// CI5 (I6, DI9): resposta de GET /internal/team-whatsapp/dispatches/:id/alert.
const person = {
  recipientId: 'r1',
  userName: 'Pessoa A',
  group: 'acked',
  status: 'REPLIED',
  ack: {
    at: '2026-11-20T13:05:00.000Z',
    kind: 'keyword',
    late: false,
    byName: null,
    note: null,
  },
  ackReply: { text: 'OK', kind: 'TEXT', at: '2026-11-20T13:05:00.000Z' },
  lastReply: null,
  eligible: false,
  mayHaveReceived: false,
  closure: null,
};

const panel = {
  dispatchId: 'd1',
  createdAt: '2026-11-20T13:00:00.000Z',
  ackDeadlineMinutes: 15,
  ackDeadlineAt: '2026-11-20T13:15:00.000Z',
  counts: { noDelivery: 0, noReply: 0, replied: 0, acked: 1 },
  people: [person],
  reminders: {
    count: 1,
    max: 3,
    nextAllowedAt: '2026-11-20T13:15:00.000Z',
    items: [
      {
        dispatchId: 'd2',
        createdAt: '2026-11-20T13:10:00.000Z',
        authorName: 'Gestor',
        recipients: 1,
      },
    ],
  },
};

const parses = (value: unknown) =>
  teamAlertPanelSchema.safeParse(value).success;
const without = (value: object, key: string) =>
  Object.fromEntries(Object.entries(value).filter(([k]) => k !== key));
const withPerson = (extra: Record<string, unknown>) => ({
  ...panel,
  people: [{ ...person, ...extra }],
});

describe('teamAlertPanelSchema (CI5)', () => {
  it('painel exige os campos de CI5', () => {
    expect(parses(panel)).toBe(true);
    for (const key of Object.keys(panel)) {
      expect(parses(without(panel, key)), key).toBe(false);
    }
    for (const key of Object.keys(person)) {
      const people = [without(person, key)];
      expect(parses({ ...panel, people }), key).toBe(false);
    }
    expect(parses({ ...panel, counts: { ...panel.counts, acked: -1 } })).toBe(
      false,
    );
    expect(
      parses({
        ...panel,
        reminders: { ...panel.reminders, nextAllowedAt: null },
      }),
    ).toBe(true);
  });

  it('grupo, tipo da ciência e tipo da mensagem só aceitam os valores do contrato', () => {
    expect(parses(withPerson({ group: 'pending' }))).toBe(false);
    expect(
      parses(withPerson({ ack: { ...person.ack, kind: 'KEYWORD' } })),
    ).toBe(false);
    expect(
      parses(withPerson({ lastReply: { text: null, kind: 'AUDIO', at: 'x' } })),
    ).toBe(true);
    expect(
      parses(
        withPerson({ lastReply: { text: null, kind: 'REACTION', at: 'x' } }),
      ),
    ).toBe(false);
    expect(parses(withPerson({ ack: null, ackReply: null }))).toBe(true);
  });
});
