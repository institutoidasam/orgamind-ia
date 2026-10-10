import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NumberRegistry } from "./number-registry";

class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver = globalThis.ResizeObserver ?? (ResizeObserverStub as never);
if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};

const hooks = vi.hoisted(() => ({
  create: { mutateAsync: vi.fn(), isPending: false },
  update: { mutateAsync: vi.fn(), isPending: false },
  toast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock("../api", () => ({
  useInternalNumbers: () => ({ data: { items: [{ id: "n1", name: "Recepção", phone: "+5592999990000", provider: "META", sectorId: "s1", sector: { id: "s1", name: "Engenharia", code: "ENG", isActive: true }, routeToSector: true, channelId: null, configurationStatus: "UNCONFIGURED", routingStatus: "PENDING", channel: null, createdAt: "2026-10-10", updatedAt: "2026-10-10" }] }, isLoading: false, isError: false }),
  useSectors: () => ({ data: { items: [{ id: "s1", name: "Engenharia" }] } }),
  useCreateInternalNumber: () => hooks.create,
  useUpdateInternalNumber: () => hooks.update,
}));
vi.mock("@/features/whatsapp/api", () => ({ useProviders: () => ({ data: { providers: [] } }) }));
vi.mock("sonner", () => ({ toast: hooks.toast }));

beforeEach(() => {
  vi.clearAllMocks();
  hooks.create.isPending = false;
  hooks.update.isPending = false;
});

describe("NumberRegistry", () => {
  it("shows pending state, opens structural registration and opens details", async () => {
    const user = userEvent.setup();
    render(<NumberRegistry />);
    expect(screen.getByRole("heading", { name: "Números e canais." })).toBeInTheDocument();
    expect(screen.getByText("A configurar")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cadastrar número" }));
    expect(screen.getByRole("heading", { name: "Cadastrar número" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancelar" }));
    await user.click(screen.getByRole("button", { name: "Detalhes" }));
    expect(screen.getByText("Nenhum canal externo configurado para este cadastro.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Editar cadastro" }));
    expect(screen.getByRole("heading", { name: "Editar número" })).toBeInTheDocument();
  });

  it("posts a structural record and reports a network failure without a false success", async () => {
    hooks.create.mutateAsync.mockResolvedValueOnce({ id: "n2" });
    const user = userEvent.setup();
    render(<NumberRegistry />);
    await user.click(screen.getByRole("button", { name: "Cadastrar número" }));
    await user.type(screen.getByLabelText("Nome"), "Portaria");
    await user.clear(screen.getByLabelText("Número E.164"));
    await user.type(screen.getByLabelText("Número E.164"), "+5592999991111");
    await user.click(screen.getByRole("combobox", { name: "Setor responsável" }));
    await user.click(screen.getByRole("option", { name: "Engenharia" }));
    await user.click(screen.getByRole("button", { name: "Salvar vínculo" }));
    await expect.poll(() => hooks.create.mutateAsync.mock.calls.length).toBe(1);
    expect(hooks.create.mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ name: "Portaria", sectorId: "s1" }));
    expect(hooks.toast.success).toHaveBeenCalledWith("Vínculo estrutural salvo");

    hooks.create.mutateAsync.mockRejectedValueOnce(new Error("offline"));
    await user.click(screen.getByRole("button", { name: "Cadastrar número" }));
    await user.type(screen.getByLabelText("Nome"), "Falha");
    await user.clear(screen.getByLabelText("Número E.164"));
    await user.type(screen.getByLabelText("Número E.164"), "+5592999992222");
    await user.click(screen.getByRole("combobox", { name: "Setor responsável" }));
    await user.click(screen.getByRole("option", { name: "Engenharia" }));
    await user.click(screen.getByRole("button", { name: "Salvar vínculo" }));
    await expect.poll(() => hooks.toast.error.mock.calls.length).toBe(1);
    expect(hooks.toast.success).toHaveBeenCalledTimes(1);
  });

  it("patches an existing record and leaves no connected state implied while pending", async () => {
    hooks.update.mutateAsync.mockResolvedValueOnce({ id: "n1" });
    const user = userEvent.setup();
    render(<NumberRegistry />);
    await user.click(screen.getByRole("button", { name: "Detalhes" }));
    await user.click(screen.getByRole("button", { name: "Editar cadastro" }));
    await user.clear(screen.getByLabelText("Nome"));
    await user.type(screen.getByLabelText("Nome"), "Recepção nova");
    await user.click(screen.getByRole("button", { name: "Salvar vínculo" }));
    await expect.poll(() => hooks.update.mutateAsync.mock.calls.length).toBe(1);
    expect(hooks.update.mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ name: "Recepção nova" }));
    expect(screen.queryByText("Conectado")).not.toBeInTheDocument();
  });
});
