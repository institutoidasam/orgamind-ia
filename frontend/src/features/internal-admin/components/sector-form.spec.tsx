import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAuthStore, type AuthUser } from "@/stores/auth.store";
import type { Sector } from "../schemas";
import { SectorForm } from "./sector-form";

const calls = vi.hoisted(() => ({ users: vi.fn() }));

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

vi.mock("@/features/users/api", () => ({
  useAllUsers: () => ({
    ...calls.users(),
    data: [
      {
        id: "admin",
        email: "admin@gbr.com",
        name: "Admin",
        role: "ADMIN",
        hasAccess: true,
        isActive: true,
      },
      {
        id: "viewer",
        email: "viewer@gbr.com",
        name: "Leitura",
        role: "VIEWER",
        hasAccess: true,
        isActive: true,
      },
      {
        id: "inactive",
        email: "inactive@gbr.com",
        name: "Inativo",
        role: "OPERATOR",
        hasAccess: true,
        isActive: false,
      },
      {
        id: "semacesso",
        email: null,
        name: "Sem Acesso",
        role: "OPERATOR",
        hasAccess: false,
        isActive: true,
      },
    ],
  }),
}));

const USER = { id: "u1", email: "u@gbr.com", name: "U" } as const;
const asRole = (role: AuthUser["role"]) =>
  useAuthStore.setState({ user: { ...USER, role } });
const SECTOR: Sector = {
  id: "s1", name: "Produção", code: "PRD", isActive: true, description: null,
  managerId: "m1", manager: { id: "m1", name: "Marta", email: null },
  memberCount: 0, channel: null, createdAt: "", updatedAt: "",
};
const renderForm = (sector?: Sector, onSubmit = async () => {}) =>
  render(<SectorForm sector={sector} pending={false} onCancel={() => {}} onSubmit={onSubmit} />);

beforeEach(() => {
  calls.users.mockClear();
  asRole("ADMIN");
});

describe("SectorForm: gestor só do administrador (DB20)", () => {
  it("o formulário do ADMIN lista gestores de GET /users como hoje", async () => {
    renderForm(SECTOR);
    fireEvent.click(screen.getByRole("combobox", { name: "Gestor" }));
    expect(await screen.findByRole("option", { name: "Admin" })).toBeTruthy();
    expect(calls.users).toHaveBeenCalled();
  });

  it("quem não é ADMIN não vê o campo Gestor, não chama GET /users e vê 'Gestor: <nome>'", () => {
    asRole("SUPERVISOR");
    renderForm(SECTOR);
    expect(screen.queryByRole("combobox", { name: "Gestor" })).toBeNull();
    expect(screen.getByText("Gestor: Marta")).toBeTruthy();
    expect(calls.users).not.toHaveBeenCalled();
  });

  it("sem gestor definido mostra 'Gestor: A definir'", () => {
    asRole("OPERATOR");
    renderForm({ ...SECTOR, managerId: null, manager: null });
    expect(screen.getByText("Gestor: A definir")).toBeTruthy();
  });

  it("o envio de quem não é ADMIN reenvia o gestor gravado, que a API não grava", async () => {
    asRole("SUPERVISOR");
    const onSubmit = vi.fn(async () => {});
    renderForm(SECTOR, onSubmit);
    fireEvent.click(screen.getByRole("button", { name: "Salvar setor" }));
    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({ code: "PRD", managerId: "m1" });
  });
});

describe("SectorForm", () => {
  it("expõe campos e selects por nomes acessíveis", () => {
    render(
      <SectorForm
        pending={false}
        onCancel={() => {}}
        onSubmit={async () => {}}
      />,
    );
    expect(screen.getByLabelText("Nome do setor")).toBeTruthy();
    expect(screen.getByLabelText("Sigla")).toBeTruthy();
    expect(screen.getByLabelText("Descrição")).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Gestor" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Estado" })).toBeTruthy();
  });

  it("oferece apenas gestores ativos com papel elegível", async () => {
    render(
      <SectorForm
        pending={false}
        onCancel={() => {}}
        onSubmit={async () => {}}
      />,
    );
    fireEvent.click(screen.getByRole("combobox", { name: "Gestor" }));
    expect(await screen.findByRole("option", { name: "Admin" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "Leitura" })).toBeNull();
    expect(screen.queryByRole("option", { name: "Inativo" })).toBeNull();
  });

  it("Gestor não lista pessoa sem acesso", async () => {
    render(
      <SectorForm
        pending={false}
        onCancel={() => {}}
        onSubmit={async () => {}}
      />,
    );
    fireEvent.click(screen.getByRole("combobox", { name: "Gestor" }));
    expect(await screen.findByRole("option", { name: "Admin" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "Sem Acesso" })).toBeNull();
  });
});
