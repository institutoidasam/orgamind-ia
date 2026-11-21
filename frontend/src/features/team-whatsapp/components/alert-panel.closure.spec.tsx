import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { alertPanel, alertPerson, minutesAfter } from "../alert.test-fixtures";
import { AlertPanel } from "./alert-panel";

const closed = alertPerson({
  recipientId: "bia",
  userName: "Bia",
  group: "no_reply",
  closure: {
    at: "2026-11-20T13:30:00.000Z",
    byName: "Gestor S1",
    reason: "Falou por ligação",
  },
});
const panelWith = (people = [closed]) =>
  alertPanel({
    counts: { noDelivery: 0, noReply: people.length, replied: 0, acked: 0 },
    people,
  });

describe("AlertPanel: tratativa encerrada", () => {
  it("aceite 20: pessoa encerrada aparece no mesmo grupo com a linha", () => {
    render(<AlertPanel panel={panelWith()} now={minutesAfter(31)} />);
    const item = within(
      screen.getByRole("list", { name: "Sem resposta (1)" }),
    ).getByRole("listitem");
    expect(item).toHaveTextContent("Bia · Pendente");
    expect(
      within(item).getByText(
        "Tratativa encerrada por Gestor S1: Falou por ligação",
      ),
    ).toBeInTheDocument();
  });

  it("resposta sem closure (back antigo) — nada muda", () => {
    // O fixture não traz `closure`: é o formato do back que ainda não manda o campo.
    const legacy = alertPerson({ recipientId: "bia", userName: "Bia" });
    render(<AlertPanel panel={panelWith([legacy])} now={minutesAfter(31)} />);
    expect(screen.getByRole("listitem")).toHaveTextContent("Bia · Pendente");
    expect(screen.queryByText(/Tratativa encerrada/)).not.toBeInTheDocument();
  });
});
