import { QueryClient } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  del: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));
vi.mock("@/lib/api-client", () => ({
  api: { delete: (...a: unknown[]) => mocks.del(...a) },
}));
vi.mock("sonner", () => ({
  toast: { success: mocks.success, error: mocks.error },
}));

import {
  clientWrapper,
  httpError,
  signInWith,
} from "../alert-actions.test-fixtures";
import type { AlertPerson } from "../alert-schemas";
import { alertPanel, alertPerson, minutesAfter } from "../alert.test-fixtures";
import { AlertPanel } from "./alert-panel";

const at = "2026-11-20T13:03:00.000Z";
const acked = (name: string, kind: "keyword" | "manual"): AlertPerson =>
  alertPerson({
    recipientId: `r-${name}`,
    userName: name,
    group: "acked",
    status: "REPLIED",
    eligible: false,
    ack: { at, kind, late: false, byName: "Carla", note: "por ligação" },
  });
const panel = alertPanel({
  counts: { noDelivery: 0, noReply: 1, replied: 0, acked: 2 },
  people: [
    alertPerson({ recipientId: "r-Ana", userName: "Ana" }),
    acked("Bia", "keyword"),
    acked("Caio", "manual"),
  ],
});
const show = (qc = new QueryClient()) =>
  render(<AlertPanel panel={panel} now={minutesAfter(6)} />, {
    wrapper: clientWrapper(qc),
  });
const item = (name: string) =>
  screen.getByText(name, { selector: "span" }).closest("li") as HTMLElement;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.del.mockResolvedValue(undefined);
});

describe("AlertPanel: quem pode agir", () => {
  it.each([[["equipe.enviar"]], [["equipe.urgencia"]], [[]]] as const)(
    "aceite 12: com %j, o painel aparece sem botões de lembrete nem de ciência",
    (permissions) => {
      signInWith([...permissions]);
      show();
      expect(
        screen.getByRole("heading", { name: "Pendências do alerta" }),
      ).toBeInTheDocument();
      expect(screen.queryByRole("button")).not.toBeInTheDocument();
    },
  );

  it("com as duas chaves: lembrete no painel e registrar ciência só em quem está pendente", async () => {
    signInWith(["equipe.enviar", "equipe.urgencia"]);
    show();
    expect(
      within(item("Ana")).getByRole("button", {
        name: "Registrar ciência de Ana",
      }),
    ).toBeInTheDocument();
    expect(within(item("Bia")).queryByRole("button")).not.toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Enviar lembrete aos pendentes" }),
    );
    expect(await screen.findByText("Lembrete 1 de 3")).toBeInTheDocument();
  });

  it("registrar ciência abre o diálogo da pessoa", async () => {
    signInWith(["equipe.enviar", "equipe.urgencia"]);
    show();
    await userEvent.click(
      screen.getByRole("button", { name: "Registrar ciência de Ana" }),
    );
    expect(
      await screen.findByRole("textbox", { name: "Observação" }),
    ).toBeInTheDocument();
  });

  it("sem ninguém pendente não há lembrete a mandar", () => {
    signInWith(["equipe.enviar", "equipe.urgencia"]);
    const done = alertPanel({ people: [acked("Bia", "keyword")] });
    render(<AlertPanel panel={done} now={minutesAfter(6)} />, {
      wrapper: clientWrapper(new QueryClient()),
    });
    expect(
      screen.queryByRole("button", { name: "Enviar lembrete aos pendentes" }),
    ).not.toBeInTheDocument();
  });
});

describe("AlertPanel: desfazer a ciência manual", () => {
  beforeEach(() => signInWith(["equipe.enviar", "equipe.urgencia"]));

  it("desfazer só aparece na manual; desfaz e relê o envio e o histórico", async () => {
    const qc = new QueryClient();
    const refresh = vi.spyOn(qc, "invalidateQueries");
    show(qc);
    expect(
      within(item("Bia")).queryByRole("button", { name: /Desfazer/ }),
    ).not.toBeInTheDocument();
    await userEvent.click(
      within(item("Caio")).getByRole("button", {
        name: "Desfazer ciência manual de Caio",
      }),
    );
    expect(mocks.del).toHaveBeenCalledWith(
      "internal/team-whatsapp/dispatches/d1/recipients/r-Caio/ack",
    );
    await waitFor(() =>
      expect(mocks.success).toHaveBeenCalledWith("Ciência manual desfeita"),
    );
    expect(refresh).toHaveBeenCalledWith({
      queryKey: ["team-whatsapp", "dispatch", "d1"],
    });
    expect(refresh).toHaveBeenCalledWith({
      queryKey: ["team-whatsapp", "dispatches"],
    });
  });

  it("ack_not_manual vira o texto no toast", async () => {
    mocks.del.mockRejectedValue(httpError(422, "team_whatsapp.ack_not_manual"));
    show();
    await userEvent.click(
      screen.getByRole("button", { name: "Desfazer ciência manual de Caio" }),
    );
    await waitFor(() =>
      expect(mocks.error).toHaveBeenCalledWith(
        "Só a ciência manual pode ser desfeita.",
      ),
    );
  });
});
