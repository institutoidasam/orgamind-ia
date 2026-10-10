import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const sectors = vi.hoisted(() => ({ current: { data: { items: [] }, isLoading: false, isError: false, refetch: vi.fn() } }));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => options,
  Link: ({ children }: { children: React.ReactNode }) => <a href="#">{children}</a>,
}));
vi.mock("@/features/internal-admin/api", () => ({ useSectors: () => sectors.current }));

import { Route } from "./index";

function renderSectors() {
  const route = Route as unknown as { component: React.ComponentType };
  return render(<route.component />);
}

describe("/setores", () => {
  it("renders the persisted sector list with its owner, members and numbers", () => {
    sectors.current = { data: { items: [{ id: "s1", name: "Engenharia", code: "ENG", isActive: true, manager: { name: "Ana" }, memberCount: 3, numberCount: 2 }] }, isLoading: false, isError: false, refetch: vi.fn() };
    renderSectors();
    expect(screen.getByRole("link", { name: "Engenharia" })).toBeInTheDocument();
    expect(screen.getByText("Ana")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
  });

  it("explains when no persisted sector exists", () => {
    sectors.current = { data: { items: [] }, isLoading: false, isError: false, refetch: vi.fn() };
    renderSectors();
    expect(screen.getByText("Nenhum setor cadastrado.")).toBeInTheDocument();
  });
});
