import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { RoleSelect, SectorSelect } from "./role-sector-selects";

class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver = globalThis.ResizeObserver ?? (ResizeObserverStub as never);
if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};

describe("role and sector selects", () => {
  it("uses the four canonical roles and permits clearing a sector", async () => {
    const onRole = vi.fn();
    const onSector = vi.fn();
    const user = userEvent.setup();
    render(<><RoleSelect value="OPERATOR" onChange={onRole} /><SectorSelect value="s1" onChange={onSector} sectors={[{ id: "s1", name: "Engenharia" }]} /></>);
    await user.click(screen.getByRole("combobox", { name: "Perfil" }));
    expect(screen.getByRole("option", { name: "Leitura" })).toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: "Administrador" }));
    expect(onRole).toHaveBeenCalledWith("ADMIN");
    await user.click(screen.getByRole("combobox", { name: "Setor principal" }));
    await user.click(screen.getByRole("option", { name: "Sem setor" }));
    expect(onSector).toHaveBeenCalledWith(null);
  });
});
