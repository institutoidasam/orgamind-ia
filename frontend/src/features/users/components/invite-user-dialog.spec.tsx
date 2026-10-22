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
import { toast } from "sonner";
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
vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  useInviteUser: () => ({ mutateAsync, isPending: false }),
}));
vi.mock("@/features/levels/api", () => ({
  useLevels: () => ({
    data: [
      { id: "lv1", name: "Líder", isActive: true, sortOrder: 0, userCount: 2 },
      { id: "lv2", name: "Antigo", isActive: false, sortOrder: 1, userCount: 0 },
    ],
  }),
}));
vi.mock("@/features/internal-admin/api", () => ({
  useSectors: () => ({
    data: { items: [{ id: "sector-1", name: "Engenharia" }] },
  }),
}));
vi.mock("@/features/shifts/api", () => ({
  useShifts: () => ({
    data: [
      { id: "sh1", name: "Manhã", startTime: "06:00", endTime: "14:00", isActive: true, sortOrder: 0, crossesMidnight: false, inUse: [] },
      { id: "sh2", name: "Tarde", startTime: "14:00", endTime: "22:00", isActive: true, sortOrder: 1, crossesMidnight: false, inUse: [] },
    ],
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
    fireEvent.click(await screen.findByRole("option", { name: "Tarde" }));
    fireEvent.click(submitButton());
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ shiftId: "sh2" }));
  });

  describe("job title and invalid shift", () => {
    async function fillAdminWithJobTitle(jobTitle: string) {
      await userEvent.type(emailInput(), "admin@x.com");
      await userEvent.type(phoneInput(), PHONE);
      fireEvent.change(screen.getByLabelText("Função (opcional)"), { target: { value: jobTitle } });
      fireEvent.click(screen.getByRole("combobox", { name: "Perfil" }));
      fireEvent.click(await screen.findByRole("option", { name: "Administrador" }));
      fireEvent.click(submitButton());
    }

    it("sends the job title typed in Função", async () => {
      wrap(dialog(true));
      await fillAdminWithJobTitle("Operador de empilhadeira");
      await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
      expect(mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ jobTitle: "Operador de empilhadeira" }));
    });

    it("blocks a job title with 81 characters", async () => {
      wrap(dialog(true));
      await fillAdminWithJobTitle("x".repeat(81));
      expect(await screen.findByText("Use até 80 caracteres")).toBeTruthy();
      expect(mutateAsync).not.toHaveBeenCalled();
    });

    it("shows 422 users.invalid_shift as a stale-list message", async () => {
      rejectOnce("users.invalid_shift", 422);
      wrap(dialog(true));
      await fillAdminWithJobTitle("");
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Turno inválido. Atualize a página."));
    });
  });
});

describe("InviteUserDialog acesso ao sistema e nível", () => {
  const accessTrigger = () => screen.getByRole("combobox", { name: "Acesso ao sistema" });
  async function chooseNoAccess() {
    fireEvent.click(accessTrigger());
    fireEvent.click(await screen.findByRole("option", { name: "Sem acesso" }));
  }

  it("começa Com acesso", () => {
    wrap(dialog(true));
    expect(accessTrigger()).toHaveTextContent("Com acesso");
  });

  it("Sem acesso esconde e-mail, perfil e senha, não exige setor e envia hasAccess false", async () => {
    mutateAsync.mockResolvedValueOnce({ user: {}, temporaryPassword: null });
    wrap(dialog(true));
    await chooseNoAccess();
    expect(document.querySelector('input[type="email"]')).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Perfil" })).toBeNull();
    await userEvent.type(screen.getByLabelText("Nome"), "Rita");
    await userEvent.type(phoneInput(), PHONE);
    fireEvent.click(submitButton());
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    const payload = mutateAsync.mock.calls[0][0];
    expect(payload).toMatchObject({ hasAccess: false, name: "Rita", phone: PHONE, sectorId: null });
    expect(payload).not.toHaveProperty("email");
    expect(payload).not.toHaveProperty("role");
    expect(screen.queryByText("Senha temporária criada")).toBeNull();
  });

  it("Sem acesso exige o nome", async () => {
    wrap(dialog(true));
    await chooseNoAccess();
    await userEvent.type(phoneInput(), PHONE);
    fireEvent.click(submitButton());
    expect(await screen.findByText("Informe o nome")).toBeTruthy();
    expect(mutateAsync).not.toHaveBeenCalled();
  });
});

describe("InviteUserDialog acesso ao sistema e nível", () => {
  it("Com acesso segue o fluxo de hoje e leva o nível escolhido", async () => {
    wrap(dialog(true));
    await userEvent.type(emailInput(), "op@x.com");
    await userEvent.type(phoneInput(), PHONE);
    fireEvent.click(screen.getByRole("combobox", { name: "Setor principal" }));
    fireEvent.click(await screen.findByRole("option", { name: "Engenharia" }));
    fireEvent.click(screen.getByRole("combobox", { name: "Nível" }));
    fireEvent.click(await screen.findByRole("option", { name: "Líder" }));
    fireEvent.click(submitButton());
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    const payload = mutateAsync.mock.calls[0][0];
    expect(payload).toMatchObject({ email: "op@x.com", role: "OPERATOR", sectorId: "sector-1", levelId: "lv1" });
    expect(payload).not.toHaveProperty("hasAccess");
  });

  it("Nível lista só ativos, mais Sem nível", async () => {
    wrap(dialog(true));
    const trigger = screen.getByRole("combobox", { name: "Nível" });
    expect(trigger).toHaveTextContent("Sem nível");
    fireEvent.click(trigger);
    const names = (await screen.findAllByRole("option")).map((option) => option.textContent);
    expect(names).toEqual(["Sem nível", "Líder"]);
  });
});
