import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { AlertPerson } from "../alert-schemas";
import { alertPanel, alertPerson, minutesAfter } from "../alert.test-fixtures";
import { AlertPanel } from "./alert-panel";

const at = (hhmm: string) => `2026-11-20T${hhmm}:00.000Z`;
const msg = (text: string | null, kind = "TEXT") => ({
  text,
  kind,
  at: at("13:03"),
});
const acked = (over: Partial<AlertPerson>): AlertPerson =>
  alertPerson({
    recipientId: "ana",
    userName: "Ana",
    group: "acked",
    status: "REPLIED",
    ack: {
      at: at("13:03"),
      kind: "keyword",
      late: false,
      byName: null,
      note: null,
    },
    ...over,
  });
const group = (title: string) =>
  within(screen.getByRole("list", { name: title }));

describe("AlertPanel: prazo e ciência automática", () => {
  const panel = alertPanel({
    counts: { noDelivery: 0, noReply: 1, replied: 0, acked: 1 },
    people: [
      acked({ ackReply: msg("OK") }),
      alertPerson({ recipientId: "bia", userName: "Bia" }),
    ],
  });

  it("aceite 6: Ciente às HH:mm e o texto OK; Sem resposta com Pendente · há N min; passados 15 min, Pendente — prazo vencido", () => {
    const { rerender } = render(
      <AlertPanel panel={panel} now={minutesAfter(3)} />,
    );
    expect(
      screen.getByText("Prazo de ciência: 15 min — vence às 09:15"),
    ).toBeInTheDocument();
    expect(group("Ciente (1)").getByRole("listitem")).toHaveTextContent(
      "Ana · Ciente às 09:03",
    );
    expect(group("Ciente (1)").getByText("OK")).toBeInTheDocument();
    expect(group("Sem resposta (1)").getByRole("listitem")).toHaveTextContent(
      "Bia · Pendente · há 3 min",
    );
    expect(
      screen.getByRole("heading", { name: "Sem entrega (0)" }),
    ).toBeInTheDocument();
    rerender(<AlertPanel panel={panel} now={minutesAfter(15)} />);
    expect(
      screen.getByText("Prazo de ciência: 15 min — vencido às 09:15"),
    ).toBeInTheDocument();
    expect(group("Sem resposta (1)").getByRole("listitem")).toHaveTextContent(
      "Bia · Pendente — prazo vencido",
    );
  });
});

describe("AlertPanel: ciência depois do prazo", () => {
  it("aceite 16: Ciente (após o prazo) às HH:mm", () => {
    const late = acked({
      ack: {
        at: at("13:20"),
        kind: "keyword",
        late: true,
        byName: null,
        note: null,
      },
    });
    render(
      <AlertPanel
        panel={alertPanel({
          counts: { noDelivery: 0, noReply: 0, replied: 0, acked: 1 },
          people: [late],
        })}
        now={minutesAfter(30)}
      />,
    );
    expect(group("Ciente (1)").getByRole("listitem")).toHaveTextContent(
      "Ana · Ciente (após o prazo) às 09:20",
    );
  });
});

describe("AlertPanel: ciência manual", () => {
  it("aceite 11: manual mostra Obs. e autor e a última resposta abaixo", () => {
    const manual = acked({
      ack: {
        at: at("13:05"),
        kind: "manual",
        late: false,
        byName: "Carla",
        note: "confirmou por ligação",
      },
      ackReply: null,
      lastReply: msg("já vi"),
    });
    render(
      <AlertPanel
        panel={alertPanel({
          counts: { noDelivery: 0, noReply: 0, replied: 0, acked: 1 },
          people: [manual],
        })}
        now={minutesAfter(6)}
      />,
    );
    const item = group("Ciente (1)").getByRole("listitem");
    expect(item).toHaveTextContent("Ana · Ciente (manual) às 09:05");
    const lines = within(item)
      .getAllByText(/./, { selector: "p" })
      .map((p) => p.textContent);
    expect(lines.slice(1)).toEqual([
      "Obs.: confirmou por ligação — Carla",
      "já vi",
    ]);
  });
});

describe("AlertPanel: resposta sem ciência", () => {
  it("aceite 7: Respondeu, sem ciência com o texto da última resposta; sem texto vira (Áudio)", () => {
    const replied = alertPerson({
      recipientId: "caio",
      userName: "Caio",
      group: "replied",
      status: "REPLIED",
      lastReply: msg("Estou chegando"),
    });
    const voice = alertPerson({
      recipientId: "duda",
      userName: "Duda",
      group: "replied",
      status: "REPLIED",
      lastReply: msg(null, "AUDIO"),
    });
    render(
      <AlertPanel
        panel={alertPanel({
          counts: { noDelivery: 0, noReply: 0, replied: 2, acked: 0 },
          people: [replied, voice],
        })}
        now={minutesAfter(4)}
      />,
    );
    const [first, second] = group("Respondeu, sem ciência (2)").getAllByRole(
      "listitem",
    );
    expect(first).toHaveTextContent("Caio · Pendente · há 4 minEstou chegando");
    expect(second).toHaveTextContent("Duda · Pendente · há 4 min(Áudio)");
  });
});

describe("AlertPanel: lembretes", () => {
  it("aceite 20: lista de lembretes com hora, autor e quantas pessoas", () => {
    const items = [
      {
        dispatchId: "l1",
        createdAt: at("13:06"),
        authorName: "Carla",
        recipients: 3,
      },
      {
        dispatchId: "l2",
        createdAt: at("13:12"),
        authorName: "Davi",
        recipients: 1,
      },
    ];
    const reminders = { count: 2, max: 3, nextAllowedAt: at("13:17"), items };
    const { rerender } = render(
      <AlertPanel panel={alertPanel({ reminders })} now={minutesAfter(13)} />,
    );
    const list = within(
      screen.getByRole("list", { name: "Lembretes do alerta" }),
    );
    expect(list.getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "09:06 · Carla · 3 pessoas",
      "09:12 · Davi · 1 pessoa",
    ]);
    rerender(<AlertPanel panel={alertPanel()} now={minutesAfter(13)} />);
    expect(screen.queryByText("Lembretes do alerta")).not.toBeInTheDocument();
  });
});
