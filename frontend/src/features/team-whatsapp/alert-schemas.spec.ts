import { describe, expect, it } from "vitest";
import { teamAlertPanelSchema } from "./alert-schemas";
import { alertPanel, alertPerson } from "./alert.test-fixtures";
import { dispatchDetailSchema, dispatchListSchema } from "./schemas";

const zero = {
  queued: 0,
  sent: 0,
  delivered: 0,
  read: 0,
  replied: 0,
  failed: 0,
  uncertain: 0,
  skipped: 0,
  scheduled: 0,
  cancelled: 0,
};
const listItem = {
  id: "d1",
  createdAt: "2026-11-20T13:00:00.000Z",
  author: null,
  target: { type: "sector", id: "s1", label: "Logística", shift: null },
  sectors: [{ id: "s1", name: "Logística" }],
  channels: [],
  counts: zero,
  rosterDate: null,
  state: "DISPATCHED",
  scheduledFor: null,
  firedAt: null,
  purpose: "urgency",
  base: "on_duty",
  activity: null,
  urgencyReason: "Falta de energia",
};
const detail = {
  id: "d1",
  targetLabel: "Logística",
  text: "Aviso",
  state: "DISPATCHED",
  createdAt: "2026-11-20T13:00:00.000Z",
  scheduledFor: null,
  firedAt: null,
  author: null,
  sectors: [],
  channels: [],
  counts: zero,
  leftOut: { unselected: [], off: [] },
  purpose: "urgency",
  base: "on_duty",
  rule: null,
};
const alertFields = {
  ackDeadlineMinutes: 15,
  ackDeadlineAt: "2026-11-20T13:15:00.000Z",
  reminderOf: { dispatchId: "a1", createdAt: "2026-11-20T13:00:00.000Z" },
};

describe("alert-schemas: contrato tolerante", () => {
  it("esquemas aceitam resposta sem os campos novos", () => {
    const list = dispatchListSchema.parse({
      items: [listItem],
      total: 1,
      page: 1,
      pageSize: 20,
    });
    expect(list.items[0].ackDeadlineMinutes).toBeUndefined();
    expect(dispatchDetailSchema.parse(detail).reminderOf).toBeUndefined();
  });

  it("lista e detalhe trazem o prazo e o alerta de origem quando o servidor os manda", () => {
    const list = dispatchListSchema.parse({
      items: [{ ...listItem, ...alertFields }],
      total: 1,
      page: 1,
      pageSize: 20,
    });
    expect(list.items[0]).toMatchObject(alertFields);
    expect(
      dispatchDetailSchema.parse({ ...detail, ...alertFields }),
    ).toMatchObject(alertFields);
  });

  it("painel: ciência e respostas ausentes viram pendente sem texto, nunca Ciente", () => {
    const { ack, ackReply, lastReply, ...bare } = alertPerson();
    void [ack, ackReply, lastReply];
    const { reminders, ...head } = alertPanel();
    const parsed = teamAlertPanelSchema.parse({
      ...head,
      people: [bare],
      reminders: { count: reminders.count, max: reminders.max, items: [] },
    });
    expect(parsed.people[0].ack).toBeUndefined();
    expect(parsed.reminders.nextAllowedAt).toBeUndefined();
    expect(() =>
      teamAlertPanelSchema.parse({
        ...head,
        people: [{ ...bare, group: "other" }],
        reminders,
      }),
    ).toThrow();
  });
});
