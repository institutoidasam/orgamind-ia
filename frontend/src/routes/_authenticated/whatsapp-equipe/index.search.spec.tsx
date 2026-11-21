import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentType } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  search: {} as { sectorIds?: string; date?: string },
  useTeamTargets: vi.fn(),
  useAudiencePreview: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (opts: Record<string, unknown>) => ({
    ...opts,
    useSearch: () => mocks.search,
  }),
  Link: ({ children }: { children: React.ReactNode }) => (
    <a href="/x">{children}</a>
  ),
}));
vi.mock("@/features/team-whatsapp/api", () => ({
  useTeamTargets: () => mocks.useTeamTargets(),
  useTeamDispatches: () => ({
    data: undefined,
    isLoading: true,
    isError: false,
  }),
  useTeamRoster: () => ({ data: undefined, isLoading: true, isError: false }),
  useAudiencePreview: (body: unknown) => mocks.useAudiencePreview(body),
  useScheduledDispatches: () => ({
    data: undefined,
    isLoading: true,
    isError: false,
  }),
  useCancelDispatch: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/features/team-whatsapp/components/send-whatsapp-dialog", () => ({
  SendWhatsappDialog: () => <div role="dialog">Diálogo</div>,
}));

import { useAuthStore } from "@/stores/auth.store";
import { Route } from "./index";

const route = Route as unknown as {
  component: ComponentType;
  validateSearch: (search: Record<string, unknown>) => {
    sectorIds?: string;
    date?: string;
  };
};

const manha = {
  id: "manha",
  name: "Manhã",
  startTime: "06:00",
  endTime: "14:00",
};
const sectors = [
  { id: "s1", name: "Produção", code: "PROD" },
  { id: "s2", name: "Expedição", code: "EXP" },
  { id: "s3", name: "Logística", code: "LOG" },
];
const targets = {
  today: "2026-10-21",
  inProgress: null,
  shifts: [manha],
  sectors,
  levels: [],
};

const openWith = (search: Record<string, unknown>) => {
  mocks.search = route.validateSearch(search);
  return render(<route.component />);
};
const checked = (name: string) =>
  (screen.getByRole("checkbox", { name }) as HTMLInputElement).getAttribute(
    "aria-checked",
  );
const marked = () =>
  sectors.filter((s) => checked(s.name) === "true").map((s) => s.name);

beforeEach(() => {
  useAuthStore.setState({
    user: { id: "u1", email: "o@x.test", name: "Olga", role: "OPERATOR" },
  });
  mocks.useTeamTargets.mockReturnValue({
    data: targets,
    isLoading: false,
    isError: false,
  });
  mocks.useAudiencePreview.mockReturnValue({
    data: undefined,
    isFetching: false,
    error: null,
    refetch: vi.fn(),
  });
});
afterEach(cleanup);

describe("/whatsapp-equipe: setores e data na URL (aceites 6 e 7)", () => {
  it("aceite 6: ?sectorIds=<id>&date=2026-11-18 — setor marcado e data na tela", () => {
    openWith({ sectorIds: "s2", date: "2026-11-18" });
    expect(marked()).toEqual(["Expedição"]);
    expect(screen.getByLabelText("Data")).toHaveValue("2026-11-18");
  });

  it("aceite 7: ?date= sem sectorIds com 3 setores no alcance — nenhum marcado, lista visível", () => {
    openWith({ date: "2026-11-18" });
    expect(screen.getByRole("group", { name: "Setores" })).toBeInTheDocument();
    expect(marked()).toEqual([]);
    expect(checked("Todos os setores")).toBe("false");
    expect(screen.getByLabelText("Data")).toHaveValue("2026-11-18");
  });

  it("aceite 6: setor fora do alcance e data inválida — ignorados, sem erro", () => {
    const { unmount } = openWith({
      sectorIds: "inativo,s3",
      date: "2026-02-30",
    });
    expect(marked()).toEqual(["Logística"]);
    expect(screen.getByLabelText("Data")).toHaveValue("2026-10-21");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    unmount();

    openWith({ sectorIds: "inativo" });
    expect(marked()).toEqual([]);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("/whatsapp-equipe: o carregamento não prepara envio", () => {
  it("nenhuma prévia nem envio sai no carregamento (nenhum POST)", async () => {
    openWith({ sectorIds: "s1,s2", date: "2026-11-18" });
    expect(marked()).toEqual(["Produção", "Expedição"]);
    expect(mocks.useAudiencePreview).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(
      screen.getByText("Escolha o setor, a data e o turno"),
    ).toBeInTheDocument();

    await userEvent
      .setup()
      .click(screen.getByRole("checkbox", { name: "Manhã" }));
    const body = mocks.useAudiencePreview.mock.calls.find(
      ([arg]) => arg !== null,
    )?.[0];
    expect(body).toMatchObject({
      target: { sectorIds: ["s1", "s2"], date: "2026-11-18" },
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
