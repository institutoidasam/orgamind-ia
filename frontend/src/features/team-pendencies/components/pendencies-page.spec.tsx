import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { usePendencyList } = vi.hoisted(() => ({ usePendencyList: vi.fn() }));
vi.mock("@tanstack/react-router", () => import("./pendency.test-router"));
vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  usePendencyList,
}));

import { useAuthStore, type AuthUser } from "@/stores/auth.store";
import type { TeamPendencyList } from "../schemas";
import { pendencyItem } from "../pendency.test-fixtures";
import { PendenciesPage } from "./pendencies-page";

const refetch = vi.fn();

function listOf(overrides: Partial<TeamPendencyList> = {}): TeamPendencyList {
  return {
    items: [pendencyItem()],
    total: 1,
    page: 1,
    pageSize: 20,
    sectors: [{ id: "s1", name: "Setor 1" }],
    truncated: false,
    ...overrides,
  };
}

/** O que `useQuery` devolve, no que a tela olha. */
const answer = (data: TeamPendencyList | null | undefined, extra = {}) => ({
  data,
  isError: false,
  isPlaceholderData: false,
  refetch,
  ...extra,
});

function renderPage(role: AuthUser["role"] = "OPERATOR") {
  useAuthStore.setState({
    user: { id: "u1", email: "a@b.c", name: "A", role },
  });
  const client = new QueryClient();
  const invalidate = vi.spyOn(client, "invalidateQueries");
  render(
    <QueryClientProvider client={client}>
      <PendenciesPage />
    </QueryClientProvider>,
  );
  return { invalidate };
}

const lastFilters = () => usePendencyList.mock.lastCall![0];

beforeEach(() => {
  usePendencyList.mockReset();
  refetch.mockReset();
  usePendencyList.mockReturnValue(answer(listOf()));
});

describe("PendenciesPage: conteúdo", () => {
  it("título Pendências da equipe e a lista na ordem da resposta", () => {
    const items = ["Pessoa B", "Pessoa A"].map((name, index) => {
      const base = pendencyItem();
      return pendencyItem({
        id: `r${index}`,
        person: { ...base.person, name },
        conversationId: "c1",
      });
    });
    usePendencyList.mockReturnValue(answer(listOf({ items, total: 2 })));
    renderPage("ADMIN");
    expect(
      screen.getByRole("heading", { name: "Pendências da equipe" }),
    ).toBeInTheDocument();
    const rows = screen.getAllByRole("article");
    expect(
      rows.map((row) => within(row).getByText(/ · Setor 1/).textContent),
    ).toEqual(["Pessoa B · Setor 1 · Manhã", "Pessoa A · Setor 1 · Manhã"]);
    expect(
      screen.getAllByRole("link", { name: "Abrir conversa" }),
    ).toHaveLength(2);
    expect(usePendencyList).toHaveBeenCalledWith(expect.anything(), true);
  });

  it("truncated — aviso dos 2.000", () => {
    usePendencyList.mockReturnValue(answer(listOf({ truncated: true })));
    renderPage();
    expect(
      screen.getByText(
        "A lista passou de 2.000 pendências; use os filtros para ver as demais.",
      ),
    ).toBeInTheDocument();
  });

  it("ao montar invalida o contador", () => {
    const { invalidate } = renderPage();
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["team-pendencies", "count"],
    });
  });
});

describe("PendenciesPage: quem consulta e estados", () => {
  it("aceite 12: VIEWER — nenhuma consulta", () => {
    usePendencyList.mockReturnValue(answer(undefined));
    renderPage("VIEWER");
    expect(usePendencyList).toHaveBeenCalledWith(expect.anything(), false);
    expect(
      screen.getByText("Esta tela é para quem envia mensagens à equipe."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("article")).toBeNull();
  });

  it("403 forbidden — Esta tela é para quem envia mensagens à equipe.", () => {
    usePendencyList.mockReturnValue(answer(null));
    renderPage("SUPERVISOR");
    expect(
      screen.getByText("Esta tela é para quem envia mensagens à equipe."),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Setor")).toBeNull();
  });

  it("carregando, erro com Tentar de novo, vazio", () => {
    usePendencyList.mockReturnValue(answer(undefined));
    renderPage();
    expect(screen.getByText("Carregando pendências…")).toBeInTheDocument();
    usePendencyList.mockReturnValue(answer(undefined, { isError: true }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Minhas" }));
    expect(
      screen.getByText("Não foi possível carregar as pendências"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Tentar de novo" }));
    expect(refetch).toHaveBeenCalledTimes(1);
    usePendencyList.mockReturnValue(answer(listOf({ items: [], total: 0 })));
    fireEvent.click(screen.getByRole("checkbox", { name: "Minhas" }));
    expect(
      screen.getByText("Nenhuma pendência com estes filtros."),
    ).toBeInTheDocument();
  });
});

describe("PendenciesPage: filtros e paginação", () => {
  it("paginação Anterior/Próxima; trocar filtro volta à página 1", () => {
    usePendencyList.mockReturnValue(answer(listOf({ total: 45 })));
    renderPage();
    expect(screen.getByRole("button", { name: "Anterior" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Próxima" }));
    expect(lastFilters().page).toBe(2);
    fireEvent.click(screen.getByRole("button", { name: "Anterior" }));
    expect(lastFilters().page).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Próxima" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Minhas" }));
    expect(lastFilters()).toMatchObject({ page: 1, mine: true });
  });

  it("o seletor de setor recebe os setores da resposta", () => {
    renderPage();
    expect(screen.getByRole("option", { name: "Setor 1" })).toBeInTheDocument();
  });

  it("página que ficou vazia depois de uma ação volta à última que existe", () => {
    usePendencyList.mockImplementation(({ page }: { page: number }) =>
      page === 1
        ? answer(listOf({ total: 45 }))
        : answer(listOf({ items: [], total: 20, page })),
    );
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Próxima" }));
    expect(lastFilters().page).toBe(1);
    expect(screen.getAllByRole("article")).toHaveLength(1);
  });
});
