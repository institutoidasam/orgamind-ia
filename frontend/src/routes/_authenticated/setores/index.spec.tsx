import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ user: { id: "admin", role: "ADMIN" } as { id: string; role: string } }));
const sectors = vi.hoisted(() => ({ current: { data: { items: [] }, isLoading: false, isError: false, refetch: vi.fn() } }));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => options,
  Link: ({ children }: { children: React.ReactNode }) => <a href="#">{children}</a>,
}));
vi.mock("@/stores/auth.store", () => ({
  useAuthStore: (select: (state: { user: typeof auth.user }) => unknown) => select({ user: auth.user }),
}));
vi.mock("@/features/internal-admin/api", () => ({ useSectors: () => sectors.current }));

import { Route } from "./index";

function renderSectors() {
  const route = Route as unknown as { component: React.ComponentType };
  return render(<route.component />);
}

describe("/setores", () => {
  beforeEach(() => {
    auth.user = { id: "admin", role: "ADMIN" };
  });

  it("renders the persisted sector list with its owner, members and numbers", () => {
    const channel = { id: "c1", name: "Loja 1", phoneE164: "+5592911111111" };
    sectors.current = { data: { items: [{ id: "s1", name: "Engenharia", code: "ENG", isActive: true, manager: { name: "Ana" }, memberCount: 3, channel }] }, isLoading: false, isError: false, refetch: vi.fn() };
    renderSectors();
    expect(screen.getByRole("link", { name: "Engenharia" })).toBeInTheDocument();
    expect(screen.getByText("Ana")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("+5592911111111")).toBeInTheDocument();
    expect(screen.queryByText("Sem número")).toBeNull();
  });

  it("mostra o selo 'Sem número' quando o setor não tem número", () => {
    sectors.current = { data: { items: [{ id: "s1", name: "RH", code: "RH", isActive: true, manager: null, memberCount: 1, channel: null }] }, isLoading: false, isError: false, refetch: vi.fn() };
    renderSectors();
    expect(screen.getByText("Sem número")).toBeInTheDocument();
  });

  it("explains when no persisted sector exists", () => {
    sectors.current = { data: { items: [] }, isLoading: false, isError: false, refetch: vi.fn() };
    renderSectors();
    expect(screen.getByText("Nenhum setor cadastrado.")).toBeInTheDocument();
  });

  it("gestor vê só os setores que gerencia, sem 'Novo setor'", () => {
    auth.user = { id: "m1", role: "SUPERVISOR" };
    const item = (id: string, name: string, managerId: string) => ({ id, name, code: id, isActive: true, manager: { id: managerId, name: "X" }, memberCount: 1, channel: null });
    sectors.current = { data: { items: [item("s1", "Engenharia", "m1"), item("s2", "Vendas", "outro")] }, isLoading: false, isError: false, refetch: vi.fn() };
    renderSectors();
    expect(screen.getByRole("link", { name: "Engenharia" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Vendas" })).toBeNull();
    expect(screen.queryByRole("link", { name: /Novo setor/ })).toBeNull();
  });

  it("sem setor gerido mostra 'Você não gerencia nenhum setor.'", () => {
    auth.user = { id: "m1", role: "OPERATOR" };
    sectors.current = { data: { items: [{ id: "s2", name: "Vendas", code: "VEN", isActive: true, manager: { id: "outro", name: "X" }, memberCount: 1, channel: null }] }, isLoading: false, isError: false, refetch: vi.fn() };
    renderSectors();
    expect(screen.getByText("Você não gerencia nenhum setor.")).toBeInTheDocument();
  });
});
