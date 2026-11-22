import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { usePendencyList } = vi.hoisted(() => ({ usePendencyList: vi.fn() }));
vi.mock("@tanstack/react-router", () => import("./pendency.test-router"));
vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  usePendencyList,
}));
// O diálogo só consulta depois de aberto; aqui as leituras ficam pendentes.
vi.mock("@/lib/api-client", () => ({
  api: { get: () => new Promise(() => undefined), post: vi.fn() },
}));

import { useAuthStore, type AuthUser } from "@/stores/auth.store";
import type { TeamPendencyItem } from "../schemas";
import { pendencyItem } from "../pendency.test-fixtures";
import { PendenciesPage } from "./pendencies-page";

const OWN_BUTTON = "Passar minhas pendências";
const handledBy = (id: string, name: string | null): TeamPendencyItem =>
  pendencyItem({
    situation: "IN_PROGRESS",
    handler: { id, name, state: "active" },
  });

function renderPage(
  role: AuthUser["role"],
  item: TeamPendencyItem,
  permissions?: AuthUser["permissions"],
) {
  usePendencyList.mockReturnValue({
    data: {
      items: [item],
      total: 1,
      page: 1,
      pageSize: 20,
      sectors: [],
      truncated: false,
    },
    isError: false,
    isPlaceholderData: false,
  });
  useAuthStore.setState({
    user: { id: "u1", email: "a@b.c", name: "A", role, permissions },
  });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <PendenciesPage />
    </QueryClientProvider>,
  );
}

const rowButton = (name: string) => screen.queryByRole("button", { name });

beforeEach(() => usePendencyList.mockReset());

describe("PendenciesPage: passagem de pendências", () => {
  it("Passar minhas pendências só com equipe.enviar", () => {
    renderPage("OPERATOR", handledBy("u1", "A"), ["equipe.enviar"]);
    fireEvent.click(screen.getByRole("button", { name: OWN_BUTTON }));
    expect(
      screen.getByRole("heading", { name: OWN_BUTTON }),
    ).toBeInTheDocument();
  });

  it("sem equipe.enviar não aparece o botão", () => {
    renderPage("OPERATOR", handledBy("u1", "A"), []);
    expect(rowButton(OWN_BUTTON)).toBeNull();
  });

  it("aceite 28: ADMIN vê Passar as pendências de {nome} na linha de outro responsável", () => {
    renderPage("ADMIN", handledBy("u-other", "Gestor S1"));
    fireEvent.click(
      screen.getByRole("button", { name: "Passar as pendências de Gestor S1" }),
    );
    expect(
      screen.getByRole("heading", {
        name: "Passar as pendências de Gestor S1",
      }),
    ).toBeInTheDocument();
  });

  it("aceite 28: SUPERVISOR não vê; ADMIN não vê na própria linha nem sem responsável", () => {
    renderPage("SUPERVISOR", handledBy("u-other", "Gestor S1"));
    expect(rowButton("Passar as pendências de Gestor S1")).toBeNull();
    expect(rowButton(OWN_BUTTON)).not.toBeNull();
    cleanup();
    renderPage("ADMIN", handledBy("u1", "A"));
    expect(rowButton("Passar as pendências de A")).toBeNull();
    cleanup();
    renderPage("ADMIN", pendencyItem());
    expect(
      screen.queryByRole("button", { name: /Passar as pendências de/ }),
    ).toBeNull();
  });
});
