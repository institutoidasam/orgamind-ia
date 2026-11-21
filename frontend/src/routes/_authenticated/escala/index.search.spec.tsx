import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentType } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  search: {} as { sectorId?: string; date?: string },
  navigate: vi.fn(),
  useScheduleOptions: vi.fn(),
  useScheduleBoard: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (opts: Record<string, unknown>) => ({
    ...opts,
    useSearch: () => mocks.search,
  }),
  useNavigate: () => mocks.navigate,
}));
vi.mock("@/features/staff-schedule/api", () => ({
  useScheduleOptions: () => mocks.useScheduleOptions(),
  useScheduleBoard: (q: unknown) => mocks.useScheduleBoard(q),
  useCreateException: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDeleteException: () => ({ mutateAsync: vi.fn(), isPending: false }),
  usePutSchedule: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDeleteSchedule: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/features/staff-schedule/components/schedule-board", () => ({
  ScheduleBoardTable: () => null,
}));
vi.mock("@/features/people-export/components/export-schedule-menu", () => ({
  ExportScheduleMenu: () => null,
}));

import { Route } from "./index";

const route = Route as unknown as {
  component: ComponentType;
  validateSearch: (search: Record<string, unknown>) => {
    sectorId?: string;
    date?: string;
  };
};

// Radix Select (shadcn) usa PointerEvents/scrollIntoView, que o jsdom não tem.
if (!Element.prototype.hasPointerCapture)
  Element.prototype.hasPointerCapture = () => false;
if (!Element.prototype.scrollIntoView)
  Element.prototype.scrollIntoView = () => {};

const producao = { id: "s1", name: "Produção" };
const logistica = { id: "s2", name: "Logística" };
const emptyBoard = { data: undefined, isLoading: false, isError: false };

const lastRange = () => mocks.useScheduleBoard.mock.lastCall?.[0];
const sectorBox = () => screen.getByRole("combobox", { name: "Setor" });
const openWith = (search: Record<string, unknown>) => {
  mocks.search = route.validateSearch(search);
  return render(<route.component />);
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.search = {};
  mocks.useScheduleOptions.mockReturnValue({
    data: { today: "2026-10-21", sectors: [producao, logistica], shifts: [] },
    isLoading: false,
    isError: false,
  });
  mocks.useScheduleBoard.mockImplementation(() => emptyBoard);
});

describe("/escala: setor e data na URL (aceite 6)", () => {
  it("aceite 6: /escala?sectorId=<do alcance>&date=2026-11-18 abre no setor com a semana da data", () => {
    openWith({ sectorId: "s2", date: "2026-11-18" });
    expect(sectorBox()).toHaveTextContent("Logística");
    expect(lastRange()).toEqual({
      sectorId: "s2",
      from: "2026-11-16",
      to: "2026-11-22",
    });
    expect(screen.getByText("16/11 a 22/11 de 2026")).toBeInTheDocument();
  });

  it("aceite 6: setor fora do alcance ou inativo e data inválida — tela como sem parâmetro, sem erro", () => {
    const { unmount } = openWith({ sectorId: "inativo", date: "2026-02-30" });
    expect(lastRange()).toBeNull();
    expect(
      screen.getByText("Escolha o setor para ver a escala."),
    ).toBeInTheDocument();
    expect(screen.getByText("19/10 a 25/10 de 2026")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    unmount();

    openWith({ sectorId: "s1", date: "18/11/2026" });
    expect(lastRange()).toEqual({
      sectorId: "s1",
      from: "2026-10-19",
      to: "2026-10-25",
    });
  });
});

describe("/escala: os parâmetros só preenchem o estado inicial", () => {
  it("trocar setor depois não mexe na URL nem volta ao parâmetro", async () => {
    const user = userEvent.setup();
    const { rerender } = openWith({ sectorId: "s1", date: "2026-11-18" });
    await user.click(sectorBox());
    await user.click(screen.getByRole("option", { name: "Logística" }));
    expect(lastRange()).toEqual({
      sectorId: "s2",
      from: "2026-11-16",
      to: "2026-11-22",
    });
    await user.click(screen.getByRole("button", { name: "Período anterior" }));
    rerender(<route.component />);
    expect(lastRange()).toEqual({
      sectorId: "s2",
      from: "2026-11-09",
      to: "2026-11-15",
    });
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(mocks.search).toEqual({ sectorId: "s1", date: "2026-11-18" });
  });
});
