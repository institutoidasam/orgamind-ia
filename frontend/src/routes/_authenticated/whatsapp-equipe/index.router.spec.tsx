import { cleanup, render, screen } from "@testing-library/react";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Router REAL (sem mock de @tanstack/react-router): URL → parseSearch → validateSearch → useSearch.
const loading = { data: undefined, isLoading: true, isError: false };
const mocks = vi.hoisted(() => ({ useTeamTargets: vi.fn() }));

vi.mock("@/features/team-whatsapp/api", () => ({
  useTeamTargets: () => mocks.useTeamTargets(),
  useTeamDispatches: () => loading,
  useTeamRoster: () => loading,
  useAudiencePreview: () => ({
    data: undefined,
    isFetching: false,
    error: null,
    refetch: vi.fn(),
  }),
  useScheduledDispatches: () => loading,
  useCancelDispatch: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/features/team-whatsapp/components/send-whatsapp-dialog", () => ({
  SendWhatsappDialog: () => null,
}));

import { useAuthStore } from "@/stores/auth.store";
import { Route } from "./index";

const root = createRootRoute();
Route.update({
  id: "/whatsapp-equipe/",
  path: "/whatsapp-equipe/",
  getParentRoute: () => root,
} as never);
const routeTree = root.addChildren([Route] as never);

const sectors = [
  { id: "s1", name: "Produção", code: "PROD" },
  { id: "s3", name: "Logística", code: "LOG" },
];

function openAt(url: string) {
  const history = createMemoryHistory({ initialEntries: [url] });
  const router = createRouter({ routeTree, history });
  render(<RouterProvider router={router} />);
  return router;
}

const checked = (name: string) =>
  screen.getByRole("checkbox", { name }).getAttribute("aria-checked");

beforeEach(() => {
  useAuthStore.setState({
    user: { id: "u1", email: "o@x.test", name: "Olga", role: "OPERATOR" },
  });
  mocks.useTeamTargets.mockReturnValue({
    data: {
      today: "2026-10-21",
      inProgress: null,
      shifts: [],
      sectors,
      levels: [],
    },
    isLoading: false,
    isError: false,
  });
});
afterEach(cleanup);

describe("/whatsapp-equipe com o router real: data da URL (DJ8, aceite 6)", () => {
  it("date=2026-11-18 válida: setor marcado e a data na tela", async () => {
    openAt("/whatsapp-equipe?sectorIds=s3&date=2026-11-18");
    expect(await screen.findByLabelText("Data")).toHaveValue("2026-11-18");
    expect(checked("Logística")).toBe("true");
  });

  it("date=2026-02-30 (não é data de calendário): ignorada, data de hoje, sem erro", async () => {
    const router = openAt("/whatsapp-equipe?sectorIds=s3&date=2026-02-30");
    expect(await screen.findByLabelText("Data")).toHaveValue("2026-10-21");
    expect(checked("Logística")).toBe("true");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    // O que a página lê em useSearch() também não carrega a data inválida.
    expect(router.state.matches.at(-1)?.search).toMatchObject({
      sectorIds: "s3",
      date: undefined,
    });
  });
});
