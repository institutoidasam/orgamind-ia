import { QueryClient } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ post: vi.fn(), success: vi.fn() }));
vi.mock("@/lib/api-client", () => ({
  api: { post: (...a: unknown[]) => mocks.post(...a) },
}));
vi.mock("sonner", () => ({ toast: { success: mocks.success } }));

import { clientWrapper, httpError } from "../alert-actions.test-fixtures";
import { alertPerson } from "../alert.test-fixtures";
import { ManualAckDialog } from "./manual-ack-dialog";

const onClose = vi.fn();
const open = (
  person = alertPerson({ recipientId: "r-ana", userName: "Ana" }),
) =>
  render(<ManualAckDialog alertId="d1" person={person} onClose={onClose} />, {
    wrapper: clientWrapper(new QueryClient()),
  });
const note = () => screen.getByRole("textbox", { name: "Observação" });
const save = () => screen.getByRole("button", { name: "Registrar ciência" });
const typed = async (text: string) => {
  await userEvent.click(note());
  await userEvent.paste(text);
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.post.mockResolvedValue(undefined);
});

describe("ManualAckDialog: observação de 1 a 200", () => {
  it("aceite 11: sem observação desligado; com ela, envia note aparada e fecha", async () => {
    open();
    expect(screen.getByText(/Ana/)).toBeInTheDocument();
    expect(save()).toBeDisabled();
    await typed("   ");
    expect(save()).toBeDisabled();
    await typed("  confirmou por ligação  ");
    expect(save()).toBeEnabled();
    await userEvent.click(save());
    expect(mocks.post).toHaveBeenCalledWith(
      "internal/team-whatsapp/dispatches/d1/recipients/r-ana/ack",
      { json: { note: "confirmou por ligação" } },
    );
    expect(mocks.success).toHaveBeenCalledWith("Ciência registrada");
    expect(onClose).toHaveBeenCalled();
  });

  it("aceite 11: 200 caracteres passam; 201 desligam e dizem o limite", async () => {
    open();
    await typed("a".repeat(200));
    expect(screen.getByText("200/200")).toBeInTheDocument();
    expect(save()).toBeEnabled();
    await typed("b");
    expect(screen.getByText("201/200")).toBeInTheDocument();
    expect(
      screen.getByText("Use no máximo 200 caracteres."),
    ).toBeInTheDocument();
    expect(save()).toBeDisabled();
  });

  it("sem pessoa, o diálogo está fechado", () => {
    render(<ManualAckDialog alertId="d1" person={null} onClose={onClose} />, {
      wrapper: clientWrapper(new QueryClient()),
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("ManualAckDialog: recusas", () => {
  it("ack_exists mostra o texto e o diálogo continua aberto", async () => {
    mocks.post.mockRejectedValue(httpError(422, "team_whatsapp.ack_exists"));
    open();
    await typed("já falou comigo");
    await userEvent.click(save());
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Esta pessoa já tem ciência registrada.",
    );
    expect(onClose).not.toHaveBeenCalled();
  });

  it("código desconhecido cai no texto da ciência", async () => {
    mocks.post.mockRejectedValue(httpError(500));
    open();
    await typed("já falou comigo");
    await userEvent.click(save());
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Não foi possível registrar a ciência. Tente de novo.",
    );
  });
});
