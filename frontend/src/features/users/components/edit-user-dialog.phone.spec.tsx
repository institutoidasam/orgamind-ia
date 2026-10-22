import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HTTPError } from "ky";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EditUserDialog } from "./edit-user-dialog";

class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver = globalThis.ResizeObserver ?? (ResizeObserverStub as never);
if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};

const state = vi.hoisted(() => ({ mutateAsync: vi.fn(), isPending: false }));
vi.mock("../api", () => ({ useUpdateUser: () => state }));
vi.mock("@/features/internal-admin/api", () => ({ useSectors: () => ({ data: { items: [] } }) }));
vi.mock("@/features/shifts/api", () => ({ useShifts: () => ({ data: [] }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const base = {
  id: "u1", email: "ana@gbr.test", name: "Ana", role: "ADMIN" as const, phoneE164: null as string | null,
  sectorId: null, sector: null, isActive: true, lastLoginAt: null, createdAt: "2026-10-10", createdBy: null,
};
const withPhone = { ...base, phoneE164: "+5592991234567" };
const phoneInput = () => screen.getByLabelText("Telefone (WhatsApp)") as HTMLInputElement;
const open = (user: typeof base) => render(<EditUserDialog user={user} open onOpenChange={() => {}} isSelf={false} />);
const save = (ui: ReturnType<typeof userEvent.setup>) => ui.click(screen.getByRole("button", { name: "Salvar" }));

beforeEach(() => { vi.clearAllMocks(); state.mutateAsync.mockResolvedValue(undefined); });

describe("EditUserDialog phone", () => {
  it("opens with the formatted phone and blocks clearing it", async () => {
    const ui = userEvent.setup();
    open(withPhone);
    await waitFor(() => expect(phoneInput().value).toBe("(92) 99123-4567"));
    await ui.clear(phoneInput());
    await save(ui);
    expect(await screen.findByText("Telefone obrigatório")).toBeTruthy();
    expect(state.mutateAsync).not.toHaveBeenCalled();
  });

  it("sends phone only when it was changed", async () => {
    const ui = userEvent.setup();
    open(withPhone);
    await waitFor(() => expect(phoneInput().value).toBe("(92) 99123-4567"));
    await ui.clear(phoneInput());
    await ui.type(phoneInput(), "92 98888-7777");
    await save(ui);
    await waitFor(() => expect(state.mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ phone: "92 98888-7777" }) })));
  });

  it("sends phone when a legacy user without one gains it", async () => {
    const ui = userEvent.setup();
    open(base);
    await ui.type(phoneInput(), "92 98888-7777");
    await save(ui);
    await waitFor(() => expect(state.mutateAsync).toHaveBeenCalledTimes(1));
    expect(state.mutateAsync.mock.calls[0][0].data).toHaveProperty("phone", "92 98888-7777");
  });

  it("omits phone when untouched or when a legacy user stays without one", async () => {
    const ui = userEvent.setup();
    open(base);
    await save(ui);
    await waitFor(() => expect(state.mutateAsync).toHaveBeenCalledTimes(1));
    expect(state.mutateAsync.mock.calls[0][0].data).not.toHaveProperty("phone");
  });

  it("shows phone_taken next to the phone field", async () => {
    const response = new Response(JSON.stringify({ code: "user.phone_taken" }), { status: 409 });
    state.mutateAsync.mockRejectedValueOnce(new HTTPError(response, new Request("https://x"), {} as never));
    const ui = userEvent.setup();
    open(base);
    await ui.type(phoneInput(), "92 98888-7777");
    await save(ui);
    expect(await screen.findByText("Este telefone já está em uso por outro usuário.")).toBeTruthy();
  });
});
