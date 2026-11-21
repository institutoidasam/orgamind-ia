import { describe, expect, it } from "vitest";
import {
  ackLabel,
  ackLabelMap,
  alertPollInterval,
  deadlineText,
  personDetails,
  reminderOfText,
  reminderText,
  replyText,
} from "./alert-labels";
import { alertPanel, alertPerson, minutesAfter } from "./alert.test-fixtures";
import type { AlertPerson } from "./alert-schemas";

const panel = alertPanel();
const ackedAt = "2026-11-20T13:05:00.000Z";
const acked = (kind: "keyword" | "manual", late: boolean): AlertPerson =>
  alertPerson({
    group: "acked",
    ack: { at: ackedAt, kind, late, byName: null, note: null },
  });

describe("alert-labels: rótulo da ciência", () => {
  it("ackLabel: as quatro formas de Ciente com HH:mm de Manaus", () => {
    const now = minutesAfter(30);
    expect(ackLabel(acked("keyword", false), panel, now)).toBe(
      "Ciente às 09:05",
    );
    expect(ackLabel(acked("manual", false), panel, now)).toBe(
      "Ciente (manual) às 09:05",
    );
    expect(ackLabel(acked("keyword", true), panel, now)).toBe(
      "Ciente (após o prazo) às 09:05",
    );
    expect(ackLabel(acked("manual", true), panel, now)).toBe(
      "Ciente (manual, após o prazo) às 09:05",
    );
  });

  it("Pendente · há N min antes do prazo; menos de 1 min; Pendente — prazo vencido depois", () => {
    const pending = alertPerson();
    expect(ackLabel(pending, panel, minutesAfter(0, 59))).toBe(
      "Pendente · há menos de 1 min",
    );
    expect(ackLabel(pending, panel, minutesAfter(3, 30))).toBe(
      "Pendente · há 3 min",
    );
    expect(ackLabel(pending, panel, minutesAfter(14, 59))).toBe(
      "Pendente · há 14 min",
    );
    expect(ackLabel(pending, panel, minutesAfter(15))).toBe(
      "Pendente — prazo vencido",
    );
    expect(ackLabel(pending, panel, minutesAfter(-1))).toBe(
      "Pendente · há menos de 1 min",
    );
  });

  it("ackLabelMap: recipientId → rótulo; sem painel, mapa vazio", () => {
    const people = [alertPerson({ recipientId: "r1" }), acked("manual", false)];
    const map = ackLabelMap(
      alertPanel({ people: [people[0], { ...people[1], recipientId: "r2" }] }),
      minutesAfter(2),
    );
    expect([...map]).toEqual([
      ["r1", "Pendente · há 2 min"],
      ["r2", "Ciente (manual) às 09:05"],
    ]);
    expect(ackLabelMap(undefined, minutesAfter(2)).size).toBe(0);
  });
});

describe("alert-labels: prazo e resposta", () => {
  it("deadlineText: vence às / vencido às", () => {
    expect(deadlineText(panel, minutesAfter(5))).toBe(
      "Prazo de ciência: 15 min — vence às 09:15",
    );
    expect(deadlineText(panel, minutesAfter(15))).toBe(
      "Prazo de ciência: 15 min — vencido às 09:15",
    );
  });

  it("replyText: texto; sem texto → (Áudio), (Figurinha), (Mensagem sem texto)", () => {
    const msg = (text: string | null, kind: string) => ({
      text,
      kind,
      at: ackedAt,
    });
    expect(replyText(msg("OK", "TEXT"))).toBe("OK");
    expect(replyText(msg(null, "AUDIO"))).toBe("(Áudio)");
    expect(replyText(msg("  ", "IMAGE"))).toBe("(Imagem)");
    expect(replyText(msg(null, "VIDEO"))).toBe("(Vídeo)");
    expect(replyText(msg(null, "STICKER"))).toBe("(Figurinha)");
    expect(replyText(msg(null, "DOCUMENT"))).toBe("(Documento)");
    expect(replyText(msg(null, "LOCATION"))).toBe("(Mensagem sem texto)");
    expect(replyText(msg(null, "constructor"))).toBe("(Mensagem sem texto)");
  });

  it("alertPollInterval: 10 s com pendência e < 2 h; false sem pendência ou ≥ 2 h", () => {
    const pending = alertPanel({
      counts: { noDelivery: 0, noReply: 1, replied: 0, acked: 2 },
    });
    const done = alertPanel({
      counts: { noDelivery: 0, noReply: 0, replied: 0, acked: 3 },
    });
    expect(alertPollInterval(pending, minutesAfter(119, 59))).toBe(10_000);
    expect(alertPollInterval(pending, minutesAfter(120))).toBe(false);
    expect(alertPollInterval(done, minutesAfter(5))).toBe(false);
    expect(alertPollInterval(undefined, minutesAfter(5))).toBe(false);
  });
});

describe("alert-labels: abaixo do nome, lembretes e histórico", () => {
  const msg = (text: string) => ({ text, kind: "TEXT", at: ackedAt });

  it("personDetails: automática = a mensagem da ciência; manual = Obs. e autor, depois a última resposta", () => {
    const keyword = alertPerson({
      ...acked("keyword", false),
      ackReply: msg("OK"),
      lastReply: msg("depois"),
    });
    expect(personDetails(keyword)).toEqual(["OK"]);
    const manual = alertPerson({
      ack: {
        at: ackedAt,
        kind: "manual",
        late: false,
        byName: "Carla",
        note: "confirmou por ligação",
      },
      lastReply: msg("já vi"),
    });
    expect(personDetails(manual)).toEqual([
      "Obs.: confirmou por ligação — Carla",
      "já vi",
    ]);
    expect(
      personDetails(
        alertPerson({
          ...manual,
          lastReply: null,
          ack: { ...manual.ack!, byName: null },
        }),
      ),
    ).toEqual(["Obs.: confirmou por ligação"]);
    expect(
      personDetails(alertPerson({ ack: { ...manual.ack!, note: null } })),
    ).toEqual([]);
    expect(
      personDetails(alertPerson({ lastReply: msg("Estou chegando") })),
    ).toEqual(["Estou chegando"]);
    expect(personDetails(alertPerson())).toEqual([]);
  });
});

describe("alert-labels: lembretes e histórico", () => {
  it("reminderText: hora, autor e quantas pessoas; reminderOfText: dd/mm HH:mm do alerta", () => {
    const item = {
      dispatchId: "l1",
      createdAt: "2026-11-20T13:06:00.000Z",
      authorName: "Carla",
      recipients: 3,
    };
    expect(reminderText(item)).toBe("09:06 · Carla · 3 pessoas");
    expect(reminderText({ ...item, authorName: null, recipients: 1 })).toBe(
      "09:06 · — · 1 pessoa",
    );
    expect(reminderOfText({ createdAt: "2026-11-20T13:00:00.000Z" })).toBe(
      "Lembrete do alerta de 20/11 09:00",
    );
  });
});
