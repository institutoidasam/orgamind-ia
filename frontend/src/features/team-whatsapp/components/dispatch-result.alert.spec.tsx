import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
vi.mock("@/lib/api-client", () => ({
  api: { get: (...a: unknown[]) => get(...a) },
}));
vi.mock("./recipient-table", () => ({
  RecipientTable: ({
    ackLabels,
  }: {
    ackLabels?: ReadonlyMap<string, string>;
  }) => (
    <div data-testid="tabela">
      {ackLabels ? `Ciência: ${ackLabels.get("r1") ?? "—"}` : "sem coluna"}
    </div>
  ),
}));

import { alertPanel, alertPerson, minutesAfter } from "../alert.test-fixtures";
import type { DispatchDetail } from "../schemas";
import { DispatchResult } from "./dispatch-result";

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
const detail = (over: Partial<DispatchDetail> = {}): DispatchDetail => ({
  id: "d1",
  targetLabel: "Logística · Manhã · 20/11",
  text: "Falta de energia",
  state: "DISPATCHED",
  createdAt: "2026-11-20T13:00:00.000Z",
  scheduledFor: null,
  firedAt: null,
  author: { id: "a1", name: "Ada" },
  sectors: [{ id: "s1", name: "Logística" }],
  channels: [],
  counts: { ...zero, sent: 1 },
  leftOut: { unselected: [], off: [] },
  purpose: "urgency",
  base: "on_duty",
  rule: null,
  excluded: [],
  ...over,
});
const panel = alertPanel({
  counts: { noDelivery: 0, noReply: 1, replied: 0, acked: 0 },
  people: [alertPerson()],
});
const show = (dispatch: DispatchDetail) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <DispatchResult dispatch={dispatch} />
    </QueryClientProvider>,
  );

beforeEach(() => {
  get.mockReset();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(minutesAfter(3));
});
afterEach(() => vi.useRealTimers());

describe("DispatchResult: alerta urgente", () => {
  it("alerta: painel acima da tabela, que recebe o rótulo da ciência", async () => {
    get.mockReturnValue({ json: () => Promise.resolve(panel) });
    show(
      detail({ ackDeadlineMinutes: 15, ackDeadlineAt: panel.ackDeadlineAt }),
    );
    const heading = await screen.findByRole("heading", {
      name: "Pendências do alerta",
    });
    const table = screen.getByTestId("tabela");
    expect(
      heading.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(table).toHaveTextContent("Ciência: Pendente · há 3 min");
    expect(get).toHaveBeenCalledWith(
      "internal/team-whatsapp/dispatches/d1/alert",
    );
  });

  it("aceite 14: urgência antiga — sem painel, sem consulta ao painel e sem coluna", () => {
    show(
      detail({
        ackDeadlineMinutes: null,
        ackDeadlineAt: null,
        reminderOf: null,
      }),
    );
    expect(
      screen.queryByRole("heading", { name: "Pendências do alerta" }),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("tabela")).toHaveTextContent("sem coluna");
    expect(get).not.toHaveBeenCalled();
  });
});

describe("DispatchResult: lembrete e erro do painel", () => {
  it("lembrete: o cabeçalho diz de qual alerta é, e não tem painel", () => {
    show(
      detail({
        reminderOf: { dispatchId: "a1", createdAt: "2026-11-20T13:00:00.000Z" },
      }),
    );
    expect(
      screen.getByText("Lembrete do alerta de 20/11 09:00"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("tabela")).toHaveTextContent("sem coluna");
  });

  it("painel que não carrega mostra o erro e a tabela segue na tela", async () => {
    get.mockReturnValue({ json: () => Promise.reject(new Error("falhou")) });
    show(
      detail({ ackDeadlineMinutes: 15, ackDeadlineAt: panel.ackDeadlineAt }),
    );
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByTestId("tabela")).toHaveTextContent("Ciência: —");
  });
});
