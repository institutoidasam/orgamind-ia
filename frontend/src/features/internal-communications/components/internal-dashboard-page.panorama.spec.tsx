import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { get, dashboard } = vi.hoisted(() => ({
  get: vi.fn(),
  dashboard: vi.fn(),
}));
vi.mock("@/lib/api-client", () => ({ api: { get } }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));
vi.mock("../api", () => ({ useInternalDashboard: () => dashboard() }));

import {
  failWith,
  jsonOf,
  renderWithClient,
  asRole,
} from "@/features/team-panorama/panorama.test-helpers";
import { panoramaOf } from "@/features/team-panorama/panorama.test-fixtures";
import { InternalDashboardPage } from "./internal-dashboard-page";

const indicators = {
  needsAction: 4,
  nearDeadline: 2,
  waitingOthers: 1,
  unassigned: 3,
  completedThisWeek: 5,
  sector: null,
  priorities: [],
  recentUpdates: [],
};
const loaded = (data: unknown) => ({
  data,
  isLoading: false,
  isError: false,
  refetch: vi.fn(),
});

beforeEach(() => {
  get.mockReset();
  get.mockReturnValue(jsonOf(panoramaOf()));
  dashboard.mockReturnValue(loaded(indicators));
});

describe("Visão geral: bloco Operação da fábrica", () => {
  it("aceite 1: bloco aparece acima do estado vazio do usuário sem setor", async () => {
    asRole("SUPERVISOR");
    renderWithClient(<InternalDashboardPage />);
    const title = await screen.findByRole("heading", {
      name: "Operação da fábrica",
    });
    const empty = screen.getByText(
      /Peça a um administrador para definir seu setor/,
    );
    expect(
      title.compareDocumentPosition(empty) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("aceite 9: 500 — Não foi possível carregar o panorama e Tentar de novo refaz a chamada; indicadores continuam", async () => {
    get.mockReturnValue(failWith(500, "internal"));
    asRole("ADMIN");
    renderWithClient(<InternalDashboardPage />);
    expect(
      await screen.findByText("Não foi possível carregar o panorama"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("internal-dashboard-kpis")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Tentar de novo" }));
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
  });
});
