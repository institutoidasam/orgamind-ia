import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UserSummary } from "../schemas";
import { EditUserDialog } from "./edit-user-dialog";

class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver = globalThis.ResizeObserver ?? (ResizeObserverStub as never);
if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};

const { state } = vi.hoisted(() => ({ state: { mutateAsync: vi.fn(), isPending: false } }));
vi.mock("../api", () => ({
  useUpdateUser: () => state,
  useActiveLevels: () => ({ data: [{ id: "lv1", name: "Líder", isActive: true, sortOrder: 0, userCount: 1 }] }),
}));
vi.mock("@/features/internal-admin/api", () => ({ useSectors: () => ({ data: { items: [{ id: "s1", name: "Engenharia" }] } }) }));
vi.mock("@/features/shifts/api", () => ({ useShifts: () => ({ data: [] }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const base = {
  id: "u1", name: "Ana", phoneE164: null, sectorId: null, sector: null, isActive: true, lastLoginAt: null,
  createdAt: "2026-10-10", createdBy: null, shiftId: null, jobTitle: null, levelId: null, level: null,
};
const withAccess = { ...base, email: "ana@gbr.test", hasAccess: true, role: "OPERATOR" } as UserSummary;
const withoutAccess = { ...base, id: "p1", name: "Rita", email: null, hasAccess: false, role: "VIEWER" } as UserSummary;
const open = (user: UserSummary) => render(<EditUserDialog user={user} open onOpenChange={() => {}} isSelf={false} />);
const save = (ui: ReturnType<typeof userEvent.setup>) => ui.click(screen.getByRole("button", { name: "Salvar" }));

beforeEach(() => { vi.clearAllMocks(); state.mutateAsync.mockResolvedValue(undefined); });

describe("EditUserDialog nível", () => {
  it("nível inativo atual aparece selecionado (e some das opções se trocar)", async () => {
    const ui = userEvent.setup();
    open({ ...withAccess, levelId: "lv9", level: { id: "lv9", name: "Antigo", isActive: false } });
    const trigger = screen.getByRole("combobox", { name: "Nível" });
    expect(trigger).toHaveTextContent("Antigo");
    await ui.click(trigger);
    expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual(["Sem nível", "Líder", "Antigo (inativo)"]);
  });

  it("só envia o nível quando ele muda; null limpa", async () => {
    const ui = userEvent.setup();
    open({ ...withAccess, levelId: "lv1", level: { id: "lv1", name: "Líder", isActive: true } });
    await save(ui);
    await waitFor(() => expect(state.mutateAsync).toHaveBeenCalledTimes(1));
    expect(state.mutateAsync.mock.calls[0][0].data).not.toHaveProperty("levelId");

    await ui.click(screen.getByRole("combobox", { name: "Nível" }));
    await ui.click(await screen.findByRole("option", { name: "Sem nível" }));
    await save(ui);
    await waitFor(() => expect(state.mutateAsync).toHaveBeenCalledTimes(2));
    expect(state.mutateAsync.mock.calls[1][0].data).toHaveProperty("levelId", null);
  });
});

describe("EditUserDialog pessoa sem acesso", () => {
  it("não mostra perfil nem e-mail e não envia role", async () => {
    const ui = userEvent.setup();
    open(withoutAccess);
    expect(screen.queryByRole("combobox", { name: "Perfil" })).toBeNull();
    expect(screen.queryByText("Email (não editável)")).toBeNull();
    await ui.click(screen.getByRole("combobox", { name: "Nível" }));
    await ui.click(await screen.findByRole("option", { name: "Líder" }));
    await save(ui);
    await waitFor(() => expect(state.mutateAsync).toHaveBeenCalledTimes(1));
    const { id, data } = state.mutateAsync.mock.calls[0][0];
    expect(id).toBe("p1");
    expect(data).toMatchObject({ levelId: "lv1" });
    expect(data).not.toHaveProperty("role");
  });

  it("mostra Situação Ativa/Inativa sem a frase de sessões e ainda deixa inativar", async () => {
    const ui = userEvent.setup();
    open(withoutAccess);
    expect(screen.queryByText("Acesso")).toBeNull();
    expect(screen.queryByText(/encerra sessões/)).toBeNull();
    expect(screen.getByText("Situação")).toBeInTheDocument();
    await ui.click(screen.getByRole("combobox", { name: "Situação" }));
    await ui.click(await screen.findByRole("option", { name: "Inativa" }));
    await save(ui);
    await waitFor(() => expect(state.mutateAsync).toHaveBeenCalledTimes(1));
    expect(state.mutateAsync.mock.calls[0][0].data).toMatchObject({ isActive: false });
  });

  it("não deixa apagar o nome", async () => {
    const ui = userEvent.setup();
    open(withoutAccess);
    await ui.clear(screen.getByLabelText("Nome"));
    await save(ui);
    expect(await screen.findByText("Informe o nome")).toBeInTheDocument();
    expect(state.mutateAsync).not.toHaveBeenCalled();
  });
});

describe("EditUserDialog usuário com acesso", () => {
  it("mantém o campo Acesso com o aviso de sessões", () => {
    open(withAccess);
    expect(screen.getByText("Acesso")).toBeInTheDocument();
    expect(screen.getByText("Acesso inativo encerra sessões existentes.")).toBeInTheDocument();
  });
});
