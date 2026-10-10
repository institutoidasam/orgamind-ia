import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SectorForm } from "./sector-form";

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
    data: [
      {
        id: "admin",
        email: "admin@gbr.com",
        name: "Admin",
        role: "ADMIN",
        isActive: true,
      },
      {
        id: "viewer",
        email: "viewer@gbr.com",
        name: "Leitura",
        role: "VIEWER",
        isActive: true,
      },
      {
        id: "inactive",
        email: "inactive@gbr.com",
        name: "Inativo",
        role: "OPERATOR",
        isActive: false,
      },
    ],
  }),
}));

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
});
