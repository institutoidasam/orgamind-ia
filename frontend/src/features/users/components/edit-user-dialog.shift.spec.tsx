import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HTTPError } from "ky";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EditUserDialog } from "./edit-user-dialog";

class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver = globalThis.ResizeObserver ?? (ResizeObserverStub as never);
if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};

const { state, toastError, shifts } = vi.hoisted(() => ({
  state: { mutateAsync: vi.fn(), isPending: false },
  toastError: vi.fn(),
  shifts: [
    { id: "sh1", name: "Manhã", startTime: "06:00", endTime: "14:00", isActive: true, sortOrder: 0, crossesMidnight: false, inUse: [] },
    { id: "sh2", name: "Tarde", startTime: "14:00", endTime: "22:00", isActive: true, sortOrder: 1, crossesMidnight: false, inUse: [] },
    { id: "sh3", name: "Madrugada", startTime: "22:00", endTime: "06:00", isActive: false, sortOrder: 2, crossesMidnight: true, inUse: [] },
  ],
}));
vi.mock("../api", () => ({ useUpdateUser: () => state }));
vi.mock("@/features/internal-admin/api", () => ({ useSectors: () => ({ data: { items: [] } }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: toastError } }));
vi.mock("@/features/shifts/api", () => ({ useShifts: () => ({ data: shifts }) }));

const morningUser = {
  id: "u1", email: "ana@gbr.test", name: "Ana", role: "ADMIN" as const, phoneE164: null as string | null,
  sectorId: null, sector: null, isActive: true, lastLoginAt: null, createdAt: "2026-10-10", createdBy: null,
  shiftId: "sh1" as string | null, jobTitle: null as string | null,
};
const open = (isSelf: boolean) => render(<EditUserDialog user={morningUser} open onOpenChange={() => {}} isSelf={isSelf} />);
const shiftTrigger = () => screen.getByRole("combobox", { name: "Turno" });
const save = (ui: ReturnType<typeof userEvent.setup>) => ui.click(screen.getByRole("button", { name: "Salvar" }));

beforeEach(() => { vi.clearAllMocks(); state.mutateAsync.mockResolvedValue(undefined); });

describe("EditUserDialog shiftId", () => {
  it.each([false, true])("shows the current shift and clears it with null (isSelf=%s)", async (isSelf) => {
    const ui = userEvent.setup();
    open(isSelf);
    expect(shiftTrigger()).toHaveTextContent("Manhã");
    await ui.click(shiftTrigger());
    await ui.click(await screen.findByRole("option", { name: "Sem turno" }));
    await save(ui);
    await waitFor(() => expect(state.mutateAsync).toHaveBeenCalledTimes(1));
    expect(state.mutateAsync.mock.calls[0][0].data).toHaveProperty("shiftId", null);
  });

  it("switches to the other shift", async () => {
    const ui = userEvent.setup();
    open(false);
    await ui.click(shiftTrigger());
    await ui.click(await screen.findByRole("option", { name: "Tarde" }));
    await save(ui);
    await waitFor(() => expect(state.mutateAsync).toHaveBeenCalledTimes(1));
    expect(state.mutateAsync.mock.calls[0][0].data).toHaveProperty("shiftId", "sh2");
  });

  it("lists only active shifts", async () => {
    const ui = userEvent.setup();
    open(false);
    await ui.click(shiftTrigger());
    const names = (await screen.findAllByRole("option")).map((option) => option.textContent);
    expect(names).toEqual(["Sem turno", "Manhã", "Tarde"]);
  });

  it("shows 422 users.invalid_shift as a stale-list message", async () => {
    const ui = userEvent.setup();
    const response = new Response(JSON.stringify({ code: "users.invalid_shift" }), { status: 422 });
    state.mutateAsync.mockRejectedValue(new HTTPError(response, new Request("https://x/users/u1"), {} as never));
    open(false);
    await save(ui);
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Turno inválido. Atualize a página."));
  });

  it("omits shift when it was not changed", async () => {
    const ui = userEvent.setup();
    open(false);
    await save(ui);
    await waitFor(() => expect(state.mutateAsync).toHaveBeenCalledTimes(1));
    expect(state.mutateAsync.mock.calls[0][0].data).not.toHaveProperty("shiftId");
  });
});
