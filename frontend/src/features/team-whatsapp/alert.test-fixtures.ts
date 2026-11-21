import type { AlertPerson, TeamAlertPanel } from "./alert-schemas";

/** 09:00 em Manaus; o prazo de 15 min vence às 09:15. */
export const ALERT_CREATED_AT = "2026-11-20T13:00:00.000Z";
export const ALERT_DEADLINE_AT = "2026-11-20T13:15:00.000Z";

/** O instante `minutes` minutos depois da criação do alerta. */
export const minutesAfter = (minutes: number, seconds = 0): Date =>
  new Date(Date.parse(ALERT_CREATED_AT) + minutes * 60_000 + seconds * 1000);

export const alertPerson = (over: Partial<AlertPerson> = {}): AlertPerson => ({
  recipientId: "r1",
  userName: "Pessoa A",
  group: "no_reply",
  status: "DELIVERED",
  ack: null,
  ackReply: null,
  lastReply: null,
  eligible: true,
  mayHaveReceived: false,
  ...over,
});

export const alertPanel = (
  over: Partial<TeamAlertPanel> = {},
): TeamAlertPanel => ({
  dispatchId: "d1",
  createdAt: ALERT_CREATED_AT,
  ackDeadlineMinutes: 15,
  ackDeadlineAt: ALERT_DEADLINE_AT,
  counts: { noDelivery: 0, noReply: 0, replied: 0, acked: 0 },
  people: [],
  reminders: { count: 0, max: 3, nextAllowedAt: null, items: [] },
  ...over,
});
