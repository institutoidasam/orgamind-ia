import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HTTPError } from "ky";
import type { ComponentType } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  patchJson: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver =
  globalThis.ResizeObserver ?? (ResizeObserverStub as never);
if (!Element.prototype.hasPointerCapture)
  Element.prototype.hasPointerCapture = () => false;
if (!Element.prototype.scrollIntoView)
  Element.prototype.scrollIntoView = () => {};

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (opts: Record<string, unknown>) => ({
    ...opts,
    useParams: () => ({ sectorId: "s1" }),
  }),
  Link: ({ children }: { children: React.ReactNode }) => (
    <a href="#">{children}</a>
  ),
  useNavigate: () => vi.fn(),
}));
vi.mock("@/stores/auth.store", () => ({
  useAuthStore: (select: (s: { user: unknown }) => unknown) =>
    select({ user: { role: "SUPERVISOR", permissions: ["estrutura.manter"] } }),
}));
vi.mock("@/lib/api-client", () => ({
  api: { get: mocks.get, patch: () => ({ json: mocks.patchJson }) },
}));
vi.mock("@/features/users/api", () => ({ useAllUsers: () => ({ data: [] }) }));
vi.mock("@/features/sector-people/api", () => ({
  // A lista de pessoas devolve 403: a página cai em "só estrutura" (cabeçalho e painel do setor).
  useSectorPeople: () => ({
    data: undefined,
    isError: true,
    error: forbidden(),
  }),
}));
vi.mock("sonner", () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}));

import { Route } from "./$sectorId";

const route = Route as unknown as { component: ComponentType };

function httpError(status: number, code: string) {
  const error = new HTTPError(
    new Response(null, { status }),
    new Request("https://x"),
    {} as never,
  );
  error.data = { code } as HTTPError["data"];
  return error;
}
function forbidden() {
  return httpError(403, "sector_people.forbidden");
}

const FREE = { people: 0, exceptions: 0, scheduled: 0, inactivePeople: 0 };
const BUSY = { people: 2, exceptions: 1, scheduled: 1, inactivePeople: 3 };
const detail = (over: Record<string, unknown> = {}) => ({
  id: "s1",
  name: "Produção",
  code: "PRD",
  description: null,
  isActive: true,
  managerId: null,
  manager: null,
  channel: null,
  createdAt: "",
  updatedAt: "",
  members: [],
  usage: FREE,
  ...over,
});

async function open(sector: Record<string, unknown>) {
  mocks.get.mockReturnValue({ json: () => Promise.resolve(sector) });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <route.component />
    </QueryClientProvider>,
  );
  await screen.findByText("Editar setor");
}
async function pickState(label: "Ativo" | "Inativo") {
  await userEvent.click(screen.getByRole("combobox", { name: "Estado" }));
  await userEvent.click(await screen.findByRole("option", { name: label }));
}
const save = () =>
  userEvent.click(screen.getByRole("button", { name: "Salvar setor" }));
const button = (name: string) => screen.findByRole("button", { name });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.patchJson.mockResolvedValue({});
});

describe("/setores/$sectorId: setor em uso", () => {
  it("aceite 11: setor ativo em uso — Inativo desligado, Em uso: não pode ser inativado, contagens e o que fazer", async () => {
    await open(detail({ usage: BUSY }));
    expect(screen.getByText("Em uso: não pode ser inativado")).toBeTruthy();
    expect(screen.getByText("2 pessoa(s) ativa(s) neste setor")).toBeTruthy();
    expect(
      screen.getByText("1 exceção(ões) de escala de hoje em diante"),
    ).toBeTruthy();
    expect(screen.getByText("1 envio(s) agendado(s)")).toBeTruthy();
    expect(screen.getByText("Remova as exceções na Escala.")).toBeTruthy();
    expect(
      screen.getByText("3 pessoa(s) inativa(s) mantêm o vínculo"),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole("combobox", { name: "Estado" }));
    expect(
      (await screen.findByRole("option", { name: "Inativo" })).getAttribute(
        "aria-disabled",
      ),
    ).toBe("true");
  });

  it("aceite 17: renomear setor em uso — sem confirmação, grava", async () => {
    await open(detail({ usage: BUSY }));
    await userEvent.type(screen.getByLabelText("Nome do setor"), " Norte");
    await save();
    await waitFor(() => expect(mocks.patchJson).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(mocks.toastSuccess).toHaveBeenCalledWith("Setor atualizado");
  });

  it("setor inativo — reativar sem confirmação", async () => {
    await open(detail({ isActive: false }));
    await pickState("Ativo");
    await save();
    await waitFor(() => expect(mocks.patchJson).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});

describe("/setores/$sectorId: inativar com confirmação", () => {
  it("aceite 13: sem uso — Inativo, Salvar abre a confirmação com o nome; Cancelar não grava; Inativar setor grava", async () => {
    await open(detail());
    await pickState("Inativo");
    await save();
    expect(
      await screen.findByText(
        /^Inativar Produção\? Ele sai das listas de envio, escala e cadastro\./,
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/O número da área continua ligado/)).toBeNull();
    await userEvent.click(await button("Cancelar"));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(mocks.patchJson).not.toHaveBeenCalled();
    await save();
    await userEvent.click(await button("Inativar setor"));
    await waitFor(() => expect(mocks.patchJson).toHaveBeenCalledTimes(1));
    expect(mocks.toastSuccess).toHaveBeenCalledWith("Setor atualizado");
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });

  it("aceite 13: com número da área — confirmação traz o aviso do número", async () => {
    await open(
      detail({
        channel: {
          id: "c1",
          name: "Canal da produção",
          phoneE164: "+5592991110001",
        },
      }),
    );
    await pickState("Inativo");
    await save();
    expect(
      await screen.findByText(/O número da área continua ligado a este setor/),
    ).toBeTruthy();
    expect(
      screen.getByText(
        /Para usar o número em outra área, desvincule-o antes\./,
      ),
    ).toBeTruthy();
  });
});

describe("/setores/$sectorId: 409 depois de abrir a tela", () => {
  it("aceite 15: 409 sector.in_use — mensagem e nova chamada ao detalhe do setor", async () => {
    await open(detail());
    mocks.patchJson.mockRejectedValue(httpError(409, "sector.in_use"));
    mocks.get.mockReturnValue({
      json: () => Promise.resolve(detail({ usage: { ...FREE, scheduled: 1 } })),
    });
    await pickState("Inativo");
    await save();
    await userEvent.click(await button("Inativar setor"));
    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith(
        "Este setor está em uso e não pode ser inativado.",
      ),
    );
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    expect(
      await screen.findByText("Em uso: não pode ser inativado"),
    ).toBeTruthy();
    expect(mocks.get).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });
});
