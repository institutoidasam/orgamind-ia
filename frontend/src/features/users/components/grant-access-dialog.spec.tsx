import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HTTPError } from "ky";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UserSummary } from "../schemas";
import { GrantAccessDialog } from "./grant-access-dialog";

class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver = globalThis.ResizeObserver ?? (ResizeObserverStub as never);
if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};

const { grant, toastError } = vi.hoisted(() => ({
  grant: { mutateAsync: vi.fn(), isPending: false },
  toastError: vi.fn(),
}));
vi.mock("../api", () => ({ useGrantAccess: () => grant }));
vi.mock("sonner", () => ({ toast: { error: toastError, info: vi.fn(), success: vi.fn() } }));

const person = { id: "p1", name: "Rita", email: null, hasAccess: false } as UserSummary;
const submit = (ui: ReturnType<typeof userEvent.setup>) => ui.click(screen.getByRole("button", { name: "Dar acesso" }));

function rejectWith(code: string, status: number) {
  const response = new Response(JSON.stringify({ code }), { status });
  grant.mutateAsync.mockRejectedValueOnce(new HTTPError(response, new Request("https://x"), {} as never));
}

beforeEach(() => vi.clearAllMocks());

describe("GrantAccessDialog", () => {
  it("envia { email, role } e mostra a senha temporária", async () => {
    const generated = crypto.randomUUID();
    grant.mutateAsync.mockResolvedValue({ user: {}, temporaryPassword: generated });
    const ui = userEvent.setup();
    render(<GrantAccessDialog user={person} onClose={() => {}} />);
    await ui.type(screen.getByLabelText("Email"), "rita@gbr.test");
    await ui.click(screen.getByRole("combobox", { name: "Perfil" }));
    await ui.click(await screen.findByRole("option", { name: "Supervisor" }));
    await submit(ui);
    await waitFor(() => expect(grant.mutateAsync).toHaveBeenCalledWith({ id: "p1", email: "rita@gbr.test", role: "SUPERVISOR" }));
    expect(await screen.findByDisplayValue(generated)).toBeInTheDocument();
  });

  it("409 users.already_has_access mostra a mensagem", async () => {
    rejectWith("users.already_has_access", 409);
    const ui = userEvent.setup();
    render(<GrantAccessDialog user={person} onClose={() => {}} />);
    await ui.type(screen.getByLabelText("Email"), "rita@gbr.test");
    await submit(ui);
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Esta pessoa já tem acesso."));
    expect(screen.queryByLabelText("Senha temporária")).not.toBeInTheDocument();
  });

  it("não envia sem e-mail", async () => {
    const ui = userEvent.setup();
    render(<GrantAccessDialog user={person} onClose={() => {}} />);
    await submit(ui);
    expect(await screen.findByText("Email inválido")).toBeInTheDocument();
    expect(grant.mutateAsync).not.toHaveBeenCalled();
  });
});
