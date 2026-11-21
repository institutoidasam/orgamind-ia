import { cleanup, render, waitFor } from "@testing-library/react";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from "@tanstack/react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

// Router REAL (sem mock de @tanstack/react-router): URL → parseSearch → validateSearch → useSearch.
const mocks = vi.hoisted(() => ({ useScheduleBoard: vi.fn() }));

vi.mock("@/features/staff-schedule/api", () => ({
  useScheduleOptions: () => ({
    data: {
      today: "2026-10-21",
      sectors: [
        { id: "s1", name: "Produção" },
        { id: "s2", name: "Logística" },
      ],
      shifts: [],
    },
    isLoading: false,
    isError: false,
  }),
  useScheduleBoard: (q: unknown) => mocks.useScheduleBoard(q),
}));
vi.mock("@/features/staff-schedule/components/schedule-board", () => ({
  ScheduleBoardTable: () => null,
}));
vi.mock("@/features/people-export/components/export-schedule-menu", () => ({
  ExportScheduleMenu: () => null,
}));

import { Route } from "./index";

const root = createRootRoute();
Route.update({
  id: "/escala/",
  path: "/escala/",
  getParentRoute: () => root,
} as never);
const routeTree = root.addChildren([Route] as never);

function openAt(url: string) {
  mocks.useScheduleBoard.mockClear();
  mocks.useScheduleBoard.mockReturnValue({
    data: undefined,
    isLoading: false,
    isError: false,
  });
  const history = createMemoryHistory({ initialEntries: [url] });
  render(<RouterProvider router={createRouter({ routeTree, history })} />);
}

const lastRange = () => mocks.useScheduleBoard.mock.lastCall?.[0];

afterEach(cleanup);

describe("/escala com o router real: data da URL (DJ8, aceite 6)", () => {
  it("date=2026-11-20 válida: abre no setor da URL com a semana da data", async () => {
    openAt("/escala?sectorId=s2&date=2026-11-20");
    await waitFor(() =>
      expect(lastRange()).toEqual({
        sectorId: "s2",
        from: "2026-11-16",
        to: "2026-11-22",
      }),
    );
  });

  it("date=2026-02-30 (não é data de calendário): ignorada, abre na semana de hoje", async () => {
    openAt("/escala?sectorId=s2&date=2026-02-30");
    const esperado = {
      sectorId: "s2",
      from: "2026-10-19",
      to: "2026-10-25",
    };
    await waitFor(() =>
      expect(mocks.useScheduleBoard).toHaveBeenLastCalledWith(esperado),
    );
    expect(lastRange()).toEqual(esperado);
  });
});
