import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EditUserDialog } from "./edit-user-dialog";

class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver = globalThis.ResizeObserver ?? (ResizeObserverStub as never);
if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};

const state = vi.hoisted(() => ({ mutateAsync: vi.fn(), isPending: false }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("../api", () => ({ useUpdateUser: () => state }));
vi.mock("@/features/internal-admin/api", () => ({ useSectors: () => ({ data: { items: [{ id: "s1", name: "Engenharia" }] } }) }));
vi.mock("sonner", () => ({ toast }));

const user = {
  id: "u1", email: "ana@gbr.test", name: "Ana", role: "ADMIN" as const,
  sectorId: null, sector: null, isActive: true, lastLoginAt: null,
  createdAt: "2026-10-10", createdBy: null,
};

beforeEach(() => { vi.clearAllMocks(); state.mutateAsync.mockResolvedValue(undefined); });

describe("EditUserDialog", () => {
  it("sends only name for self edit and never reports success after a failure", async () => {
    const onOpenChange = vi.fn();
    const ui = userEvent.setup();
    render(<EditUserDialog user={user} open onOpenChange={onOpenChange} isSelf />);
    const name = screen.getAllByRole("textbox")[1];
    await ui.clear(name);
    await ui.type(name, "Ana Souza");
    await ui.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(state.mutateAsync).toHaveBeenCalledWith({ id: "u1", data: { name: "Ana Souza" } }));
    expect(toast.success).toHaveBeenCalledWith("Usuário atualizado.");
    expect(onOpenChange).toHaveBeenCalledWith(false);

    state.mutateAsync.mockRejectedValueOnce(new Error("falhou"));
    await ui.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(toast.success).toHaveBeenCalledTimes(1);
  });

  it("keeps administrative fields when editing another user", async () => {
    const ui = userEvent.setup();
    render(<EditUserDialog user={{ ...user, role: "OPERATOR", sectorId: "s1" }} open onOpenChange={() => {}} isSelf={false} />);
    await ui.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(state.mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ role: "OPERATOR", sectorId: "s1", isActive: true }) })));
  });
});
