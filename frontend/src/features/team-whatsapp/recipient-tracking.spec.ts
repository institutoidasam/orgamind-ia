import { describe, expect, it } from "vitest";
import { failureReasonLabel } from "./error-messages";
import { attemptsText, recipientWhen } from "./recipient-tracking";
import {
  dispatchRecipientPageSchema,
  type DispatchRecipient,
  type RecipientStatus,
} from "./schemas";

const TIMES = {
  acceptedAt: "2026-11-20T13:01:00.000Z",
  deliveredAt: "2026-11-20T13:02:00.000Z",
  readAt: "2026-11-20T13:03:00.000Z",
  repliedAt: "2026-11-20T13:04:00.000Z",
};
const withStatus = (
  status: RecipientStatus,
  over: Partial<DispatchRecipient> = {},
) => ({ status, ...TIMES, ...over });

describe("recipientWhen: a hora do estado que a linha mostra", () => {
  it("recipientWhen: hora de cada estado (SENT, DELIVERED, READ, REPLIED)", () => {
    expect(recipientWhen(withStatus("SENT"))).toBe(TIMES.acceptedAt);
    expect(recipientWhen(withStatus("DELIVERED"))).toBe(TIMES.deliveredAt);
    expect(recipientWhen(withStatus("READ"))).toBe(TIMES.readAt);
    expect(recipientWhen(withStatus("REPLIED"))).toBe(TIMES.repliedAt);
  });

  it("recipientWhen: null em QUEUED, FAILED, UNCERTAIN, SKIPPED, SCHEDULED, CANCELLED e com a hora nula", () => {
    const semHora: RecipientStatus[] = [
      "QUEUED",
      "FAILED",
      "UNCERTAIN",
      "SKIPPED",
      "SCHEDULED",
      "CANCELLED",
    ];
    expect(semHora.map((status) => recipientWhen(withStatus(status)))).toEqual(
      semHora.map(() => null),
    );
    expect(recipientWhen(withStatus("SENT", { acceptedAt: null }))).toBeNull();
  });
});

describe("attemptsText e rótulo de falha", () => {
  it("attemptsText: 2 · repetido 1×; 3 sem repetição; — · repetido 1×; —", () => {
    expect([
      attemptsText(2, 1),
      attemptsText(3, 0),
      attemptsText(0, 1),
      attemptsText(0, 0),
    ]).toEqual(["2 · repetido 1×", "3", "— · repetido 1×", "—"]);
  });

  it("failureReasonLabel de team_whatsapp.queue_lost: Saiu da fila sem envio", () => {
    expect(failureReasonLabel("team_whatsapp.queue_lost")).toBe(
      "Saiu da fila sem envio",
    );
  });
});

describe("esquema do destinatário", () => {
  const item = {
    id: "r1",
    userName: "Pessoa A",
    sectorName: null,
    levelName: null,
    shiftName: null,
    status: "SENT",
    reason: null,
    attempts: 1,
    channel: null,
    ...TIMES,
    deliveredAt: null,
    readAt: null,
    repliedAt: null,
    repeatable: false,
  };
  const parse = (over: object) =>
    dispatchRecipientPageSchema.parse({
      items: [{ ...item, ...over }],
      total: 1,
      page: 1,
      pageSize: 50,
    });

  it("esquema aceita item sem channelCheckedAt e sem manualRetries (manualRetries 0)", () => {
    const [antigo] = parse({}).items;
    expect(antigo.manualRetries).toBe(0);
    expect(antigo.channelCheckedAt ?? null).toBeNull();
    const [novo] = parse({
      channelCheckedAt: "2026-11-20T13:00:09.000Z",
      manualRetries: 2,
    }).items;
    expect(novo).toMatchObject({
      channelCheckedAt: "2026-11-20T13:00:09.000Z",
      manualRetries: 2,
    });
  });
});
