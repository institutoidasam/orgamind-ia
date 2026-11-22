import { QueryClient } from "@tanstack/react-query";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  post: vi.fn(),
  success: vi.fn(),
}));
vi.mock("@/lib/api-client", () => ({
  api: { post: (...a: unknown[]) => mocks.post(...a) },
}));
vi.mock("sonner", () => ({ toast: { success: mocks.success } }));

import {
  clientWrapper,
  httpError,
  REMINDER_ACCEPTED,
} from "../alert-actions.test-fixtures";
import type { TeamAlertPanel } from "../alert-schemas";
import { alertPanel, alertPerson, minutesAfter } from "../alert.test-fixtures";
import { reminderBlock } from "../reminder-rules";
import { ReminderDialog } from "./reminder-dialog";

const NEXT_AT = "2026-11-20T13:25:00.000Z";
const person = (name: string, over: Parameters<typeof alertPerson>[0] = {}) =>
  alertPerson({ recipientId: `r-${name}`, userName: name, ...over });
const failed = { group: "no_delivery", status: "FAILED", eligible: false };

const panel = alertPanel({
  counts: { noDelivery: 3, noReply: 2, replied: 1, acked: 1 },
  people: [
    person("Ana"),
    person("Bia", { group: "replied", status: "REPLIED" }),
    person("Caio", { status: "UNCERTAIN", mayHaveReceived: true }),
    person("Duda", failed as never),
    person("Edu", { ...failed, status: "SKIPPED" } as never),
    person("Fabi", { ...failed, status: "QUEUED" } as never),
    person("Gui", {
      group: "acked",
      eligible: false,
      ack: { at: NEXT_AT, kind: "keyword", late: false },
    }),
  ],
});

const onOpenChange = vi.fn();
const ui = (p: TeamAlertPanel, now: Date) => (
  <ReminderDialog panel={p} now={now} open onOpenChange={onOpenChange} />
);
const open = (
  p: TeamAlertPanel,
  now = minutesAfter(6),
  qc = new QueryClient(),
) => render(ui(p, now), { wrapper: clientWrapper(qc) });
const send = () => screen.getByRole("button", { name: "Enviar lembrete" });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.post.mockReturnValue({
    json: () => Promise.resolve(REMINDER_ACCEPTED),
  });
});
afterEach(() => vi.useRealTimers());

describe("ReminderDialog: quem entra e quem não entra", () => {
  it("aceite 9: lista só os elegíveis, com pode já ter recebido nos incertos, e Falhou/pulado/na fila em Não entram", () => {
    open(panel);
    expect(screen.getByText("Lembrete 1 de 3")).toBeInTheDocument();
    const who = within(
      screen.getByRole("list", { name: "Quem recebe o lembrete" }),
    );
    expect(
      who.getAllByRole("checkbox").map((c) => c.getAttribute("aria-label")),
    ).toEqual(["Ana", "Bia", "Caio"]);
    who.getAllByRole("checkbox").forEach((c) => expect(c).toBeChecked());
    expect(
      who.getByText(/pode já ter recebido/).closest("li"),
    ).toHaveTextContent("Caio");
    expect(who.getAllByText(/pode já ter recebido/)).toHaveLength(1);
    const out = within(
      screen.getByRole("list", { name: "Não entram" }),
    ).getAllByRole("listitem");
    expect(out.map((li) => li.textContent)).toEqual([
      "Duda — use Repetir na tabela",
      "Edu — tratar por outro meio (registrar ciência)",
      "Fabi — tratar por outro meio (registrar ciência)",
    ]);
    expect(screen.queryByText(/Gui/)).not.toBeInTheDocument();
  });

  it("tirar um nome manda só os marcados e depois relê o envio e o histórico", async () => {
    const qc = new QueryClient();
    const refresh = vi.spyOn(qc, "invalidateQueries");
    open(panel, minutesAfter(6), qc);
    await userEvent.click(screen.getByRole("checkbox", { name: "Bia" }));
    await userEvent.click(send());
    expect(mocks.post).toHaveBeenCalledWith(
      "internal/team-whatsapp/dispatches/d1/reminders",
      { json: { recipientIds: ["r-Ana", "r-Caio"] } },
    );
    expect(mocks.success).toHaveBeenCalledWith(
      "Lembrete na fila para 2 pessoa(s)",
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(refresh).toHaveBeenCalledWith({
      queryKey: ["team-whatsapp", "dispatch", "d1"],
    });
    expect(refresh).toHaveBeenCalledWith({
      queryKey: ["team-whatsapp", "dispatches"],
    });
  });
});

describe("ReminderDialog: limite e intervalo", () => {
  const sent = (count: number, nextAllowedAt: string | null) =>
    alertPanel({
      people: panel.people,
      reminders: { count, max: 3, nextAllowedAt, items: [] },
    });

  it("aceite 10: com 3 lembretes, botão desligado com o motivo", () => {
    open(sent(3, null));
    expect(
      screen.getByText("Já foram enviados 3 de 3 lembretes."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Este alerta já teve 3 lembretes, o máximo."),
    ).toBeInTheDocument();
    expect(send()).toBeDisabled();
  });

  it("aceite 10: antes dos 5 minutos, desligado com disponível às HH:mm; passado o intervalo, liga", () => {
    const view = open(sent(1, NEXT_AT), minutesAfter(22));
    expect(screen.getByText("Lembrete 2 de 3")).toBeInTheDocument();
    expect(
      screen.getByText("Lembrete disponível às 09:25"),
    ).toBeInTheDocument();
    expect(send()).toBeDisabled();
    view.rerender(ui(sent(1, NEXT_AT), minutesAfter(26)));
    expect(send()).toBeEnabled();
  });

  it("o relógio do diálogo anda sozinho quando o da tela parou", () => {
    vi.useFakeTimers();
    vi.setSystemTime(minutesAfter(26));
    open(sent(1, NEXT_AT), minutesAfter(22));
    expect(send()).toBeDisabled();
    act(() => vi.advanceTimersByTime(10_000));
    expect(send()).toBeEnabled();
  });
});

describe("ReminderDialog: recusas", () => {
  it("erro 409 reminder_too_soon mostra o texto e o diálogo continua aberto", async () => {
    mocks.post.mockReturnValue({
      json: () =>
        Promise.reject(httpError(409, "team_whatsapp.reminder_too_soon")),
    });
    open(panel);
    await userEvent.click(send());
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Espere 5 minutos desde o alerta ou o último lembrete.",
    );
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("código desconhecido cai no texto do lembrete", async () => {
    mocks.post.mockReturnValue({ json: () => Promise.reject(httpError(500)) });
    open(panel);
    await userEvent.click(send());
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Não foi possível enviar o lembrete. Tente de novo.",
    );
  });

  it("sem ninguém marcado ou com mais de 500, desligado com o motivo", () => {
    expect(reminderBlock(panel, 0, minutesAfter(6))).toBe(
      "Marque pelo menos uma pessoa.",
    );
    expect(reminderBlock(panel, 501, minutesAfter(6))).toBe(
      "Escolha no máximo 500 pessoas por lembrete.",
    );
    expect(reminderBlock(panel, 500, minutesAfter(6))).toBeNull();
  });
});
