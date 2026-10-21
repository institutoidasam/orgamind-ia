// invite-user-dialog.spec.tsx
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HTTPError } from "ky";
import { InviteUserDialog } from "./invite-user-dialog";

// jsdom lacks the APIs the Radix Select primitive relies on.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver =
  globalThis.ResizeObserver ?? (ResizeObserverStub as never);
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

const mutateAsync = vi
  .fn()
  .mockResolvedValue({ user: {}, temporaryPassword: "pw" });
vi.mock("../api", () => ({
  useInviteUser: () => ({ mutateAsync, isPending: false }),
}));
vi.mock("@/features/internal-admin/api", () => ({
  useSectors: () => ({
    data: { items: [{ id: "sector-1", name: "Engenharia" }] },
  }),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

const PHONE = "92 99123-4567";

function wrap(ui: React.ReactElement) {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      {ui}
    </QueryClientProvider>,
  );
}

beforeEach(() => mutateAsync.mockClear());
afterEach(() => cleanup());

function emailInput(): HTMLInputElement {
  const el = document.querySelector('input[type="email"]');
  if (!el) throw new Error("email input not found");
  return el as HTMLInputElement;
}

const phoneInput = () => screen.getByLabelText("Telefone (WhatsApp)");
const submitButton = () => screen.getByRole("button", { name: /^Cadastrar$/i });
const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const dialog = (open: boolean, onOpenChange = () => {}) => (
  <QueryClientProvider client={qc}>
    <InviteUserDialog open={open} onOpenChange={onOpenChange} />
  </QueryClientProvider>
);

describe("InviteUserDialog", () => {
  it("clears a typed email after the dialog is closed and reopened", async () => {
    const { rerender } = wrap(dialog(true));
    await userEvent.type(emailInput(), "typed@x.com");
    expect(emailInput().value).toBe("typed@x.com");
    rerender(dialog(false));
    rerender(dialog(true));
    await waitFor(() => expect(emailInput().value).toBe(""));
  });

  it("submits the role chosen in the Select (controlled, in sync)", async () => {
    wrap(dialog(true));
    await userEvent.type(emailInput(), "admin@x.com");
    await userEvent.type(phoneInput(), PHONE);
    fireEvent.click(screen.getByRole("combobox", { name: "Perfil" }));
    fireEvent.click(await screen.findByRole("option", { name: "Administrador" }));
    fireEvent.click(submitButton());
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ email: "admin@x.com", role: "ADMIN" }),
    );
  });

  it("defaults the role to OPERATOR when left unchanged", async () => {
    wrap(dialog(true));
    await userEvent.type(emailInput(), "op@x.com");
    await userEvent.type(phoneInput(), PHONE);
    fireEvent.click(screen.getByRole("combobox", { name: "Setor principal" }));
    fireEvent.click(await screen.findByRole("option", { name: "Engenharia" }));
    fireEvent.click(submitButton());
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ email: "op@x.com", role: "OPERATOR", sectorId: "sector-1" }),
    );
  });

  it("does not invite a non-admin without an active sector selection", async () => {
    wrap(dialog(true));
    await userEvent.type(emailInput(), "operator@x.com");
    await userEvent.type(phoneInput(), PHONE);
    fireEvent.click(submitButton());
    await waitFor(() =>
      expect(screen.getByText("Selecione o setor principal")).toBeTruthy(),
    );
    expect(mutateAsync).not.toHaveBeenCalled();
  });
});

function rejectOnce(code: string, status: number) {
  const response = new Response(JSON.stringify({ code }), { status });
  mutateAsync.mockRejectedValueOnce(new HTTPError(response, new Request("https://x"), {} as never));
}

describe("InviteUserDialog phone", () => {
  async function fillAdmin(phone?: string) {
    await userEvent.type(emailInput(), "admin@x.com");
    if (phone) await userEvent.type(phoneInput(), phone);
    fireEvent.click(screen.getByRole("combobox", { name: "Perfil" }));
    fireEvent.click(await screen.findByRole("option", { name: "Administrador" }));
    fireEvent.click(submitButton());
  }

  it("shows the dialog title and the phone field", () => {
    wrap(dialog(true));
    expect(screen.getByText("Cadastrar usuário")).toBeTruthy();
    expect(phoneInput().getAttribute("type")).toBe("tel");
  });

  it("requires the phone and does not call the mutation without it", async () => {
    wrap(dialog(true));
    await fillAdmin();
    await waitFor(() => expect(screen.getByText("Telefone obrigatório")).toBeTruthy());
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it("sends the typed phone to the mutation", async () => {
    wrap(dialog(true));
    await fillAdmin(PHONE);
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ phone: PHONE }));
  });

  it("shows phone_taken next to the phone field", async () => {
    rejectOnce("user.phone_taken", 409);
    wrap(dialog(true));
    await fillAdmin(PHONE);
    expect(await screen.findByText("Este telefone já está em uso por outro usuário.")).toBeTruthy();
  });

  it("maps invalid_phone to the phone field error", async () => {
    rejectOnce("user.invalid_phone", 400);
    wrap(dialog(true));
    await fillAdmin(PHONE);
    expect(await screen.findByText("Telefone inválido. Use DDD + número, com ou sem +55.")).toBeTruthy();
  });

  it("asks for DDD + number when the phone is too short", async () => {
    wrap(dialog(true));
    await fillAdmin("99123");
    expect(await screen.findByText("Informe DDD + número")).toBeTruthy();
    expect(mutateAsync).not.toHaveBeenCalled();
  });
});

describe("InviteUserDialog shift", () => {
  it("starts at Sem turno and sends the chosen shift", async () => {
    wrap(dialog(true));
    expect(screen.getByRole("combobox", { name: "Turno" })).toHaveTextContent("Sem turno");
    await userEvent.type(emailInput(), "op@x.com");
    await userEvent.type(phoneInput(), PHONE);
    fireEvent.click(screen.getByRole("combobox", { name: "Setor principal" }));
    fireEvent.click(await screen.findByRole("option", { name: "Engenharia" }));
    fireEvent.click(screen.getByRole("combobox", { name: "Turno" }));
    fireEvent.click(await screen.findByRole("option", { name: "2º turno" }));
    fireEvent.click(submitButton());
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ shift: "SECOND" }));
  });
});
