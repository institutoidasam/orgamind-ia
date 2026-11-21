import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const post = vi.fn();
const del = vi.fn();
const get = vi.fn();
vi.mock("@/lib/api-client", () => ({
  api: {
    post: (...a: unknown[]) => post(...a),
    delete: (...a: unknown[]) => del(...a),
    get: (...a: unknown[]) => get(...a),
  },
}));
const toastError = vi.fn();
const toastSuccess = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    error: (...a: unknown[]) => toastError(...a),
    success: (...a: unknown[]) => toastSuccess(...a),
  },
}));

import type { PendencyMe } from "../pendency-actions";
import type { TeamPendencyItem } from "../schemas";
import { pendencyItem, pendencyMe } from "../pendency.test-fixtures";
import { PendencyActionsBar } from "./pendency-actions-bar";
import { httpError, renderWithClient } from "./pendency.test-support";

const PENDENCY_URL = "internal/team-whatsapp/pendencies/r1";
const ACK_URL = "internal/team-whatsapp/dispatches/d1/recipients/r1/ack";
const RELOAD = { queryKey: ["team-pendencies"] };
const other = { id: "u-other", name: "Gestor S1", state: "active" } as const;
const mine = { id: "u-me", name: "Eu", state: "active" } as const;
const inactive = { id: "u-old", name: "Ex-gestor", state: "inactive" } as const;

function show(
  overrides: Partial<TeamPendencyItem>,
  me: Partial<PendencyMe> = {},
) {
  return renderWithClient(
    <PendencyActionsBar item={pendencyItem(overrides)} me={pendencyMe(me)} />,
  );
}

const click = (name: string) =>
  fireEvent.click(screen.getByRole("button", { name }));
const type = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

beforeEach(() => {
  for (const fn of [post, del, get, toastError, toastSuccess]) fn.mockReset();
  post.mockResolvedValue({});
  del.mockResolvedValue({});
});

describe("PendencyActionsBar: assumir", () => {
  it("aceite 16: Assumir — um clique com expectedHandlerId do inativo", async () => {
    show({ situation: "UNASSIGNED", handler: inactive });
    click("Assumir");
    await waitFor(() => expect(post).toHaveBeenCalledOnce());
    expect(post).toHaveBeenCalledWith(`${PENDENCY_URL}/assume`, {
      json: { expectedHandlerId: "u-old" },
    });
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith("Pendência assumida"),
    );
  });

  it("sem responsável — expectedHandlerId null", async () => {
    show({ situation: "UNASSIGNED" });
    click("Assumir");
    await waitFor(() => expect(post).toHaveBeenCalledOnce());
    expect(post.mock.calls[0][1]).toEqual({
      json: { expectedHandlerId: null },
    });
  });

  it("aceite 17: Assumir de outro — diálogo com Observação (opcional)", async () => {
    show({ situation: "IN_PROGRESS", handler: other });
    expect(screen.queryByRole("button", { name: "Assumir" })).toBeNull();
    click("Assumir de outro");
    expect(
      screen.getByRole("dialog", { name: "Assumir pendência de Gestor S1" }),
    ).toBeInTheDocument();
    type("Observação (opcional)", " Passei o caso ");
    click("Confirmar");
    await waitFor(() => expect(post).toHaveBeenCalledOnce());
    expect(post).toHaveBeenCalledWith(`${PENDENCY_URL}/assume`, {
      json: { expectedHandlerId: "u-other", note: "Passei o caso" },
    });
  });
});

describe("PendencyActionsBar: contato, encerramento e reabertura", () => {
  it.each([
    ["Registrar contato", "O que foi feito e por qual meio", "notes", "text"],
    ["Encerrar sem ciência", "Motivo", "close", "reason"],
  ])("aceite 18: %s exige texto", async (button, label, path, field) => {
    show({ situation: "IN_PROGRESS", handler: mine }, { id: "u-me" });
    click(button);
    expect(screen.getByRole("button", { name: "Confirmar" })).toBeDisabled();
    type(label, "Sem sinal por telefone");
    click("Confirmar");
    await waitFor(() => expect(post).toHaveBeenCalledOnce());
    expect(post).toHaveBeenCalledWith(`${PENDENCY_URL}/${path}`, {
      json: { expectedHandlerId: "u-me", [field]: "Sem sinal por telefone" },
    });
  });

  it("Reabrir a tratativa — confirmação", async () => {
    show({ situation: "CLOSED", handler: mine }, { id: "u-me" });
    click("Reabrir a tratativa");
    expect(
      screen.getByRole("dialog", { name: "Reabrir a tratativa?" }),
    ).toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();
    click("Confirmar");
    await waitFor(() => expect(post).toHaveBeenCalledOnce());
    expect(post).toHaveBeenCalledWith(`${PENDENCY_URL}/reopen`, {
      json: { expectedHandlerId: "u-me" },
    });
  });

  it("sem equipe.enviar nenhum botão aparece", () => {
    show({ situation: "UNASSIGNED" }, { canWrite: false, canUrgency: true });
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });
});

describe("PendencyActionsBar: ciência manual pela tela", () => {
  const withUrgency = { canUrgency: true };

  it("aceite 21: Registrar ciência manual — observação obrigatória, com recarga da lista", async () => {
    const { invalidate } = show(
      { situation: "IN_PROGRESS", handler: other },
      withUrgency,
    );
    click("Registrar ciência manual");
    expect(
      screen.getByRole("button", { name: "Registrar ciência" }),
    ).toBeDisabled();
    type("Observação", "Confirmou por ligação");
    click("Registrar ciência");
    await waitFor(() => expect(post).toHaveBeenCalledOnce());
    expect(post).toHaveBeenCalledWith(ACK_URL, {
      json: { note: "Confirmou por ligação" },
    });
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith(RELOAD));
  });

  it("aceite 21: Desfazer ciência manual — só a manual, com recarga da lista", async () => {
    const ack = { kind: "MANUAL", at: "2026-11-21T13:20:00.000Z" };
    const { invalidate } = show({ situation: "ACKED", ack }, withUrgency);
    expect(
      screen.queryByRole("button", { name: "Registrar ciência manual" }),
    ).toBeNull();
    click("Desfazer ciência manual");
    await waitFor(() => expect(del).toHaveBeenCalledExactlyOnceWith(ACK_URL));
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith(RELOAD));
    expect(toastSuccess).toHaveBeenCalledWith("Ciência manual desfeita");
  });
});

describe("PendencyActionsBar: erros da ciência manual", () => {
  const ack = { kind: "MANUAL", at: "2026-11-21T13:20:00.000Z" };

  it("erro da ciência manual — ack_exists no diálogo, com o texto do painel", async () => {
    post.mockRejectedValue(
      httpError({ code: "team_whatsapp.ack_exists" }, 422),
    );
    const { invalidate } = show(
      { situation: "UNASSIGNED" },
      { canUrgency: true },
    );
    click("Registrar ciência manual");
    type("Observação", "Confirmou por ligação");
    click("Registrar ciência");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Esta pessoa já tem ciência registrada.",
    );
    click("Voltar");
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith(RELOAD));
  });

  it.each([
    [
      "team_whatsapp.ack_not_manual",
      422,
      "Só a ciência manual pode ser desfeita.",
    ],
    [
      "team_whatsapp.dispatch_not_found",
      404,
      "Envio não encontrado. Atualize a página.",
    ],
  ])(
    "erro da ciência manual — %s: o texto do painel e a lista recarrega",
    async (code, status, text) => {
      del.mockRejectedValue(httpError({ code }, status));
      const { invalidate } = show(
        { situation: "ACKED", ack },
        { canUrgency: true },
      );
      click("Desfazer ciência manual");
      await waitFor(() => expect(toastError).toHaveBeenCalledWith(text));
      expect(invalidate).toHaveBeenCalledWith(RELOAD);
    },
  );
});

describe("PendencyActionsBar: erro e envio em voo", () => {
  it("409 pendency_taken — toast com o nome e recarga", async () => {
    const detail = JSON.stringify({
      handler: { id: "u-x", name: "Gestor S1" },
    });
    post.mockRejectedValue(
      httpError({ code: "team_whatsapp.pendency_taken", detail }, 409),
    );
    const { invalidate } = show({ situation: "UNASSIGNED" });
    click("Assumir");
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        "Gestor S1 assumiu esta pendência antes de você.",
      ),
    );
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith(RELOAD));
  });

  it("botões desligados durante o envio", async () => {
    let finish: (value: unknown) => void = vi.fn();
    post.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    show({ situation: "UNASSIGNED" }, { role: "ADMIN" });
    click("Assumir");
    for (const name of ["Assumir", "Transferir", "Encerrar sem ciência"])
      await waitFor(() =>
        expect(screen.getByRole("button", { name })).toBeDisabled(),
      );
    finish({});
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Assumir" })).toBeEnabled(),
    );
  });
});
