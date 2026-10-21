import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EditUserDialog } from "./edit-user-dialog";

class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver = globalThis.ResizeObserver ?? (ResizeObserverStub as never);
if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};

const state = vi.hoisted(() => ({ mutateAsync: vi.fn(), isPending: false }));
vi.mock("../api", () => ({ useUpdateUser: () => state }));
vi.mock("@/features/internal-admin/api", () => ({ useSectors: () => ({ data: { items: [] } }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const firstShift = {
  id: "u1", email: "ana@gbr.test", name: "Ana", role: "ADMIN" as const, phoneE164: null as string | null,
  sectorId: null, sector: null, isActive: true, lastLoginAt: null, createdAt: "2026-10-10", createdBy: null,
  shift: "FIRST" as "FIRST" | "SECOND" | null,
};
const open = (isSelf: boolean) => render(<EditUserDialog user={firstShift} open onOpenChange={() => {}} isSelf={isSelf} />);
const shiftTrigger = () => screen.getByRole("combobox", { name: "Turno" });
const save = (ui: ReturnType<typeof userEvent.setup>) => ui.click(screen.getByRole("button", { name: "Salvar" }));

beforeEach(() => { vi.clearAllMocks(); state.mutateAsync.mockResolvedValue(undefined); });

describe("EditUserDialog shift", () => {
  it.each([false, true])("shows the current shift and clears it with null (isSelf=%s)", async (isSelf) => {
    const ui = userEvent.setup();
    open(isSelf);
    expect(shiftTrigger()).toHaveTextContent("1º turno");
    await ui.click(shiftTrigger());
    await ui.click(await screen.findByRole("option", { name: "Sem turno" }));
    await save(ui);
    await waitFor(() => expect(state.mutateAsync).toHaveBeenCalledTimes(1));
    expect(state.mutateAsync.mock.calls[0][0].data).toHaveProperty("shift", null);
  });

  it("switches to the other shift", async () => {
    const ui = userEvent.setup();
    open(false);
    await ui.click(shiftTrigger());
    await ui.click(await screen.findByRole("option", { name: "2º turno" }));
    await save(ui);
    await waitFor(() => expect(state.mutateAsync).toHaveBeenCalledTimes(1));
    expect(state.mutateAsync.mock.calls[0][0].data).toHaveProperty("shift", "SECOND");
  });

  it("omits shift when it was not changed", async () => {
    const ui = userEvent.setup();
    open(false);
    await save(ui);
    await waitFor(() => expect(state.mutateAsync).toHaveBeenCalledTimes(1));
    expect(state.mutateAsync.mock.calls[0][0].data).not.toHaveProperty("shift");
  });
});
