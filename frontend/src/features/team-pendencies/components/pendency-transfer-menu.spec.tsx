import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
const post = vi.fn();
vi.mock("@/lib/api-client", () => ({
  api: {
    get: (...a: unknown[]) => get(...a),
    post: (...a: unknown[]) => post(...a),
  },
}));
const toastError = vi.fn();
vi.mock("sonner", () => ({
  toast: { error: (...a: unknown[]) => toastError(...a), success: vi.fn() },
}));

import { usePendencyAction } from "../api";
import { PendencyTransferMenu } from "./pendency-transfer-menu";
import { httpError, renderWithClient } from "./pendency.test-support";

const HANDLERS = {
  items: [
    { id: "u1", name: "Gestor S1" },
    { id: "u3", name: "Pessoa C" },
  ],
};

/** A mesma ligação da barra de ações: a mutação de ação da pendência r1, com u1 como responsável mostrado. */
function Harness() {
  const action = usePendencyAction("r1");
  return (
    <PendencyTransferMenu
      id="r1"
      expectedHandlerId="u1"
      disabled={action.isPending}
      onTransfer={(input) => action.mutate({ kind: "transfer", ...input })}
    />
  );
}

async function openMenu() {
  renderWithClient(<Harness />);
  await userEvent.click(screen.getByRole("button", { name: "Transferir" }));
}

async function pickPessoaC() {
  await openMenu();
  await userEvent.click(
    await screen.findByRole("menuitem", { name: "Pessoa C" }),
  );
  await screen.findByRole("dialog", { name: "Transferir para Pessoa C?" });
}

beforeEach(() => {
  get.mockReset().mockReturnValue({ json: () => Promise.resolve(HANDLERS) });
  post.mockReset().mockResolvedValue({});
  toastError.mockReset();
});

describe("PendencyTransferMenu: destinos", () => {
  it("lista de pendencies/:id/handlers sem o responsável atual", async () => {
    await openMenu();
    expect(
      await screen.findByRole("menuitem", { name: "Pessoa C" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Gestor S1" })).toBeNull();
    expect(get).toHaveBeenCalledWith(
      "internal/team-whatsapp/pendencies/r1/handlers",
    );
  });

  it("sem outro destino mostra Ninguém disponível.", async () => {
    get.mockReturnValue({
      json: () => Promise.resolve({ items: [HANDLERS.items[0]] }),
    });
    await openMenu();
    expect(await screen.findByText("Ninguém disponível.")).toBeInTheDocument();
  });

  it("falha ao carregar a lista avisa dentro do menu", async () => {
    get.mockReturnValue({ json: () => Promise.reject(new Error("rede")) });
    await openMenu();
    expect(
      await screen.findByText("Não foi possível carregar a lista."),
    ).toBeInTheDocument();
  });
});

describe("PendencyTransferMenu: confirmação", () => {
  it("escolher abre Transferir para {nome}? e manda toUserId e expectedHandlerId", async () => {
    await pickPessoaC();
    fireEvent.click(screen.getByRole("button", { name: "Confirmar" }));
    await waitFor(() => expect(post).toHaveBeenCalledOnce());
    expect(post).toHaveBeenCalledWith(
      "internal/team-whatsapp/pendencies/r1/transfer",
      { json: { toUserId: "u3", expectedHandlerId: "u1" } },
    );
  });

  it("Cancelar não manda nada", async () => {
    await pickPessoaC();
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(post).not.toHaveBeenCalled();
  });

  it("404 user.not_found — Esta pessoa não pode receber a pendência. Escolha outra.", async () => {
    post.mockRejectedValue(httpError({ code: "user.not_found" }, 404));
    await pickPessoaC();
    fireEvent.click(screen.getByRole("button", { name: "Confirmar" }));
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        "Esta pessoa não pode receber a pendência. Escolha outra.",
      ),
    );
  });
});
